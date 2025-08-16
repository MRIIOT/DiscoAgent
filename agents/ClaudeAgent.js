const BaseAgent = require('./BaseAgent');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const execAsync = promisify(exec);

class ClaudeAgent extends BaseAgent {
    constructor(config = {}) {
        super(config);
        this.model = config.claudeModel || 'sonnet';
        this.maxTurns = config.claudeMaxTurns || 5;
        this.useConversationMode = config.useConversationMode !== false;
        this.sessionFile = './claude-sessions.json';
    }

    async processMessage(message) {
        // Format the message for Discord context
        const prompt = `[Discord message from ${message.author}]: ${message.content}`;
        
        // Create a temporary file for the prompt to avoid escaping issues
        const tempDir = os.tmpdir();
        const tempFile = path.join(tempDir, `claude-prompt-${Date.now()}.txt`);
        
        try {
            this.logger.info(`Processing message with Claude: ${message.content.substring(0, 50)}...`);
            
            // Write prompt to temporary file
            await fs.writeFile(tempFile, prompt, 'utf8');
            this.logger.info(`Wrote prompt to temp file: ${tempFile}`);
            
            // Build the command based on conversation mode
            const isWindows = process.platform === 'win32';
            const catCommand = isWindows ? 'type' : 'cat';
            let command;
            
            this.logger.info(`Building Claude command - Mode settings: useConversationMode=${this.useConversationMode}, sessionId=${this.sessionId}`);
            
            // Always use JSON output for better session tracking
            const jsonFlag = '--output-format json';
            
            if (this.useConversationMode && this.sessionId) {
                // Resume existing conversation with session ID
                command = `${catCommand} "${tempFile}" | claude -r "${this.sessionId}" -p - --model ${this.model} ${jsonFlag}`;
                this.logger.info(`MODE: Resuming conversation with session ID: ${this.sessionId}`);
            } else if (this.useConversationMode) {
                // Start new conversation (first message)
                command = `${catCommand} "${tempFile}" | claude -p - --model ${this.model} ${jsonFlag}`;
                this.logger.info(`MODE: Starting new conversation session`);
            } else {
                // One-shot mode (no conversation memory)
                command = `${catCommand} "${tempFile}" | claude -p - --model ${this.model} --max-turns ${this.maxTurns} ${jsonFlag}`;
                this.logger.info(`MODE: One-shot mode - no conversation memory (max-turns=${this.maxTurns})`);
            }
            
            this.logger.info(`Running command: claude with prompt from file`);
            this.logger.info(`Full command: ${command}`);
            
            const { stdout, stderr } = await execAsync(command, {
                maxBuffer: 1024 * 1024 * 10,
                timeout: 60000,
                windowsHide: true,
                shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
            });
            
            // Clean up temp file
            try {
                await fs.unlink(tempFile);
            } catch (e) {
                this.logger.debug(`Could not delete temp file: ${e.message}`);
            }
            
            // Always log both stdout and stderr for debugging
            if (stdout) {
                this.logger.info(`Claude stdout (${stdout.length} chars): ${stdout.substring(0, 500)}${stdout.length > 500 ? '...' : ''}`);
            } else {
                this.logger.warn('Claude stdout is empty');
            }
            
            if (stderr) {
                this.logger.warn(`Claude stderr: ${stderr}`);
            }
            
            const response = stdout.trim();
            
            if (response) {
                try {
                    // Parse JSON response
                    const jsonResponse = JSON.parse(response);
                    
                    if (jsonResponse.session_id) {
                        // Update session ID if we got a new one
                        const channelKey = this.getChannelKey();
                        if (this.sessionId !== jsonResponse.session_id) {
                            this.sessionId = jsonResponse.session_id;
                            this.sessions[channelKey] = jsonResponse.session_id;
                            await this.saveSessions();
                            this.logger.info(`Updated Claude session ID: ${jsonResponse.session_id}`);
                        }
                    }
                    
                    if (jsonResponse.result) {
                        this.logger.info(`Claude response extracted, length: ${jsonResponse.result.length} chars`);
                        
                        return {
                            result: jsonResponse.result,
                            cost: jsonResponse.total_cost_usd || 0,
                            sessionId: jsonResponse.session_id,
                            isError: false
                        };
                    } else if (jsonResponse.is_error) {
                        this.logger.error(`Claude returned error: ${jsonResponse.result || 'Unknown error'}`);
                        return {
                            result: jsonResponse.result || 'Unknown error',
                            cost: 0,
                            isError: true
                        };
                    }
                } catch (parseError) {
                    // If not JSON, return raw response (backward compatibility)
                    this.logger.debug(`Response is not JSON, returning raw: ${parseError.message}`);
                    return {
                        result: response,
                        cost: 0,
                        isError: false
                    };
                }
            } else {
                this.logger.warn('Claude returned empty response after trimming');
                if (stderr) {
                    this.logger.error(`Returning error message due to empty stdout but stderr present`);
                    return {
                        result: `Error from Claude: ${stderr}`,
                        cost: 0,
                        isError: true
                    };
                }
                return null;
            }
        } catch (error) {
            // Try to clean up temp file on error
            try {
                await fs.unlink(tempFile);
            } catch (e) {
                // Ignore cleanup errors
            }
            
            this.logger.error(`Claude processing error: ${error.message}`);
            this.logger.error(`Error details: ${error.stack}`);
            
            // Check if session is invalid and retry without it
            if (this.sessionId && 
                (error.message.includes('session') || 
                 error.message.includes('not found') ||
                 error.message.includes('invalid'))) {
                this.logger.warn('Session may be invalid, clearing and retrying...');
                
                // Clear invalid session
                const channelKey = this.getChannelKey();
                delete this.sessions[channelKey];
                this.sessionId = null;
                await this.saveSessions();
                
                // Retry without session (will create new one)
                return await this.processMessage(message);
            }
            
            // Log additional error information
            if (error.code) {
                this.logger.error(`Error code: ${error.code}`);
            }
            if (error.signal) {
                this.logger.error(`Process killed with signal: ${error.signal}`);
            }
            if (error.stdout) {
                this.logger.error(`Error stdout: ${error.stdout}`);
            }
            if (error.stderr) {
                this.logger.error(`Error stderr: ${error.stderr}`);
            }
            
            let errorMessage = error.message;
            
            if (error.message.includes('not found') || error.message.includes('is not recognized')) {
                errorMessage = 'Claude CLI not found. Please check installation.';
            } else if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
                errorMessage = 'Claude request timed out. The query might be too complex.';
            }
            
            return {
                result: errorMessage,
                cost: 0,
                isError: true
            };
        }
    }
}

module.exports = ClaudeAgent;