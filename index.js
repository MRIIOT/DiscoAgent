const { chromium } = require('playwright');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const winston = require('winston');
require('dotenv').config();

const execAsync = promisify(exec);

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'discoagent.log' })
    ]
});

class DiscordAgent {
    constructor(config) {
        this.discordEmail = config.discordEmail;
        this.discordPassword = config.discordPassword;
        this.targetChannel = config.targetChannel;
        this.browser = null;
        this.page = null;
        this.lastMessageId = null;
        this.lastKnownAuthor = null;  // Track the last known author
        this.botName = config.botName || 'ClaudeAgent';
        this.responseDelay = config.responseDelay || 2000;
        this.claudeModel = config.claudeModel || 'sonnet';
        this.claudeMaxTurns = config.claudeMaxTurns || 5;
        this.skip2FA = config.skip2FA || false;
        this.testingMode = config.testingMode || false;
        this.filterMentions = config.filterMentions || null;
        this.claudeSessionId = null;  // Track Claude session for conversation continuity
        this.useConversationMode = config.useConversationMode !== false; // Default to true
    }

    async initialize() {
        logger.info('Initializing Discord Agent...');
        logger.info('Browser launch configuration: headless=false, persistent session=./discord-session');
        
        try {
            const context = await chromium.launchPersistentContext('./discord-session', {
                headless: false,
                viewport: { width: 1280, height: 720 }
            });
            logger.info('Browser context created successfully');
            
            this.browser = context;
            
            // Check if there are existing pages
            const pages = context.pages();
            if (pages.length > 0) {
                logger.info(`Found ${pages.length} existing page(s), using first one`);
                this.page = pages[0];
            } else {
                logger.info('Creating new page');
                this.page = await context.newPage();
            }
            
            logger.info('Navigating to Discord app...');
            await this.page.goto('https://discord.com/app', { waitUntil: 'domcontentloaded' });
            logger.info(`Page loaded. Current URL: ${this.page.url()}`);
            
            // Wait a bit for any redirects
            await this.page.waitForTimeout(2000);
            
            const currentUrl = this.page.url();
            logger.info(`After redirect check - Current URL: ${currentUrl}`);
            
            // Check if we need to login
            if (currentUrl.includes('login')) {
                logger.info('Login page detected, proceeding with authentication');
                await this.login();
            } else if (currentUrl.includes('channels')) {
                logger.info('Already logged in, found channels in URL');
            } else {
                logger.info(`Unexpected URL state: ${currentUrl}`);
                // Try to detect if we're logged in by looking for channel elements
                const hasChannels = await this.page.locator('[data-list-id="channels"]').count() > 0;
                if (hasChannels) {
                    logger.info('Channels list found - appears to be logged in');
                } else {
                    logger.info('No channels found - may need to login');
                    await this.page.goto('https://discord.com/login');
                    await this.login();
                }
            }
            
            await this.navigateToChannel();
            logger.info(`Successfully connected to channel: ${this.targetChannel}`);
            
        } catch (error) {
            logger.error(`Initialization error: ${error.message}`);
            throw error;
        }
    }

    async login() {
        logger.info('Starting login process...');
        logger.info(`Login URL: ${this.page.url()}`);
        
        try {
            // Wait for login form to be visible
            logger.info('Waiting for email input field...');
            await this.page.waitForSelector('input[name="email"]', { timeout: 10000 });
            logger.info('Email input field found');
            
            // Check if password field is also present
            const hasPasswordField = await this.page.locator('input[name="password"]').count() > 0;
            logger.info(`Password field present: ${hasPasswordField}`);
            
            // Fill email field
            logger.info(`Entering email: ${this.discordEmail.substring(0, 3)}***`);
            await this.page.fill('input[name="email"]', this.discordEmail);
            
            // Fill password field
            logger.info('Entering password...');
            await this.page.fill('input[name="password"]', this.discordPassword);
            
            // Find and click the Log In button
            logger.info('Looking for Log In button...');
            const submitButton = await this.page.locator('button[type="submit"]');
            const buttonText = await submitButton.textContent();
            logger.info(`Found submit button with text: "${buttonText}"`);
            
            logger.info('Clicking Log In button...');
            await submitButton.click();
            
            // Wait for navigation or response
            logger.info('Waiting for login response...');
            
            // Wait for either channels to load, 2FA prompt, or error message
            const result = await Promise.race([
                this.page.waitForSelector('[data-list-id="channels"]', { timeout: 30000 }).then(() => 'channels'),
                this.page.waitForSelector('[aria-label*="Auth" i], [aria-label*="2FA" i], [aria-label*="code" i]', { timeout: 30000 }).then(() => '2fa'),
                this.page.waitForSelector('[class*="error" i], [class*="invalid" i]', { timeout: 5000 }).then(() => 'error'),
                this.page.waitForTimeout(30000).then(() => 'timeout')
            ]);
            
            logger.info(`Login result: ${result}`);
            
            if (result === 'error') {
                const errorText = await this.page.locator('[class*="error" i], [class*="invalid" i]').first().textContent();
                logger.error(`Login error detected: ${errorText}`);
                throw new Error(`Login failed: ${errorText}`);
            }
            
            if (result === '2fa') {
                if (this.skip2FA) {
                    logger.warn('2FA detected but SKIP_2FA is enabled - attempting to proceed anyway');
                    // Try to proceed without waiting for 2FA
                    await this.page.waitForTimeout(3000);
                } else {
                    logger.warn('2FA authentication required. Please enter code manually in the browser window.');
                    logger.info('Waiting up to 2 minutes for 2FA completion...');
                    logger.info('(Set SKIP_2FA=true in .env to skip this wait if already authenticated)');
                    await this.page.waitForSelector('[data-list-id="channels"]', { timeout: 120000 });
                    logger.info('2FA completed successfully');
                }
            }
            
            if (result === 'timeout') {
                logger.error('Login timeout - no response after 30 seconds');
                throw new Error('Login timeout');
            }
            
            // Final check - make sure we're logged in
            const finalUrl = this.page.url();
            logger.info(`Post-login URL: ${finalUrl}`);
            
            if (finalUrl.includes('channels')) {
                logger.info('Login successful - channels URL confirmed');
            } else {
                logger.warn(`Unexpected post-login URL: ${finalUrl}`);
            }
            
        } catch (error) {
            logger.error(`Login error: ${error.message}`);
            
            // Take a screenshot for debugging
            try {
                await this.page.screenshot({ path: 'login-error.png' });
                logger.info('Screenshot saved as login-error.png');
            } catch (screenshotError) {
                logger.error('Could not save screenshot');
            }
            
            throw error;
        }
    }

    async navigateToChannel() {
        logger.info(`Attempting to navigate to channel: ${this.targetChannel}`);
        
        if (this.targetChannel.startsWith('http')) {
            await this.page.goto(this.targetChannel);
            // Wait longer for channel to fully load
            await this.page.waitForTimeout(5000);
        } else {
            // Wait for channel list to load
            await this.page.waitForSelector('[data-list-id="channels"]', { timeout: 15000 });
            
            // Try multiple selectors for channel
            const selectors = [
                `[aria-label*="${this.targetChannel}" i]`,
                `[data-dnd-name*="${this.targetChannel}" i]`,
                `text="${this.targetChannel}"`,
                `[aria-label="${this.targetChannel}"]`
            ];
            
            let clicked = false;
            for (const selector of selectors) {
                try {
                    const element = await this.page.locator(selector).first();
                    if (await element.isVisible({ timeout: 2000 })) {
                        await element.click();
                        clicked = true;
                        logger.info(`Clicked channel using selector: ${selector}`);
                        break;
                    }
                } catch (e) {
                    // Try next selector
                }
            }
            
            if (!clicked) {
                throw new Error(`Could not find channel: ${this.targetChannel}`);
            }
        }
        
        // Wait for page to stabilize
        await this.page.waitForTimeout(3000);
        
        // Debug: log what we can see on the page
        const textboxCount = await this.page.locator('[role="textbox"]').count();
        logger.info(`Found ${textboxCount} textbox elements on page`);
        
        // Wait for message input with multiple possible selectors
        const inputSelectors = [
            '[data-slate-editor="true"]',
            '[role="textbox"][data-slate-node="value"]',
            '[role="textbox"][aria-label*="Message" i]',
            '[role="textbox"][placeholder*="Message" i]',
            '[contenteditable="true"][role="textbox"]',
            'div[role="textbox"][spellcheck="true"]',
            'div[role="textbox"]'
        ];
        
        let inputFound = false;
        for (const selector of inputSelectors) {
            try {
                const element = await this.page.locator(selector).first();
                const isVisible = await element.isVisible({ timeout: 2000 }).catch(() => false);
                if (isVisible) {
                    inputFound = true;
                    logger.info(`Found message input with selector: ${selector}`);
                    
                    // Click on it to make sure it's focused
                    await element.click();
                    break;
                }
            } catch (e) {
                logger.debug(`Selector failed: ${selector}`);
            }
        }
        
        if (!inputFound) {
            // Try to find any textbox and log its attributes for debugging
            try {
                const anyTextbox = await this.page.locator('[role="textbox"]').first();
                if (await anyTextbox.isVisible()) {
                    const attrs = await anyTextbox.evaluate(el => {
                        return {
                            'aria-label': el.getAttribute('aria-label'),
                            'placeholder': el.getAttribute('placeholder'),
                            'data-slate-editor': el.getAttribute('data-slate-editor'),
                            'contenteditable': el.getAttribute('contenteditable'),
                            'class': el.className
                        };
                    });
                    logger.info('Found textbox with attributes:', JSON.stringify(attrs));
                }
            } catch (e) {
                logger.error('No textbox elements found at all');
            }
            
            throw new Error('Could not find message input field');
        }
    }

    async getNewMessages() {
        const messages = await this.page.evaluate(() => {
            const messageElements = document.querySelectorAll('[id^="message-content-"]');
            const messageList = [];
            
            messageElements.forEach(el => {
                // Try multiple ways to find the message container and author
                const messageContainer = el.closest('[id^="chat-messages-"]') || 
                                       el.closest('[class*="message-"]') || 
                                       el.closest('[class*="message"]') ||
                                       el.closest('li');
                
                // Try multiple selectors for username
                let author = 'Unknown';
                if (messageContainer) {
                    const usernameElement = messageContainer.querySelector('[class*="username-"]') ||
                                          messageContainer.querySelector('[class*="username"]') ||
                                          messageContainer.querySelector('[class*="headerText-"] span') ||
                                          messageContainer.querySelector('h3 span[class*="username"]') ||
                                          messageContainer.querySelector('[id^="message-username-"]');
                    
                    if (usernameElement) {
                        author = usernameElement.textContent.trim();
                    }
                }
                
                const timestampElement = messageContainer?.querySelector('time');
                
                messageList.push({
                    id: el.id,
                    content: el.textContent.trim(),
                    author: author,
                    timestamp: timestampElement?.getAttribute('datetime') || new Date().toISOString()
                });
            });
            
            return messageList;
        });

        const newMessages = [];
        let foundLast = !this.lastMessageId;
        
        for (const msg of messages) {
            if (!foundLast) {
                if (msg.id === this.lastMessageId) {
                    foundLast = true;
                }
                continue;
            }
            
            // If author is Unknown, use the last known author
            if (msg.author === 'Unknown' && this.lastKnownAuthor) {
                msg.author = this.lastKnownAuthor;
                logger.debug(`Using previous author name: ${this.lastKnownAuthor}`);
            } else if (msg.author !== 'Unknown') {
                // Update last known author when we find a valid name
                this.lastKnownAuthor = msg.author;
            }
            
            if (msg.author !== this.botName && msg.content && msg.content.length > 0) {
                newMessages.push(msg);
            }
        }

        if (messages.length > 0) {
            this.lastMessageId = messages[messages.length - 1].id;
        }

        return newMessages;
    }

    async sendMessage(text) {
        // Try multiple selectors for message input
        const selectors = [
            '[role="textbox"][aria-label*="Message"]',
            '[data-slate-editor="true"]',
            '[contenteditable="true"][role="textbox"]',
            'div[role="textbox"]'
        ];
        
        let messageBox = null;
        for (const selector of selectors) {
            try {
                messageBox = await this.page.locator(selector).first();
                if (await messageBox.isVisible({ timeout: 1000 })) {
                    break;
                }
            } catch (e) {
                // Try next selector
            }
        }
        
        if (!messageBox) {
            throw new Error('Could not find message input box');
        }
        
        const chunks = this.splitMessage(text);
        
        for (const chunk of chunks) {
            await messageBox.fill(chunk);
            await messageBox.press('Enter');
            await this.page.waitForTimeout(500);
        }
    }

    splitMessage(text, maxLength = 2000) {
        if (text.length <= maxLength) return [text];
        
        const chunks = [];
        let currentChunk = '';
        const lines = text.split('\n');
        
        for (const line of lines) {
            if (currentChunk.length + line.length + 1 > maxLength) {
                if (currentChunk) chunks.push(currentChunk);
                currentChunk = line;
            } else {
                currentChunk += (currentChunk ? '\n' : '') + line;
            }
        }
        
        if (currentChunk) chunks.push(currentChunk);
        return chunks;
    }

    async processWithClaude(message) {
        // Format the message for Discord context
        const prompt = `[Discord message from ${message.author}]: ${message.content}`;
        
        // Create a temporary file for the prompt to avoid escaping issues
        const tempDir = os.tmpdir();
        const tempFile = path.join(tempDir, `claude-prompt-${Date.now()}.txt`);
        
        try {
            logger.info(`Processing message with Claude: ${message.content.substring(0, 50)}...`);
            
            // Write prompt to temporary file
            await fs.writeFile(tempFile, prompt, 'utf8');
            logger.info(`Wrote prompt to temp file: ${tempFile}`);
            
            // Build the command based on conversation mode
            const isWindows = process.platform === 'win32';
            const catCommand = isWindows ? 'type' : 'cat';
            let command;
            
            if (this.useConversationMode && this.claudeSessionId) {
                // Continue existing conversation
                command = `${catCommand} "${tempFile}" | claude -c -p - --model ${this.claudeModel}`;
                logger.info(`Continuing conversation in existing session`);
            } else if (this.useConversationMode) {
                // Start new conversation (first message)
                command = `${catCommand} "${tempFile}" | claude -p - --model ${this.claudeModel}`;
                logger.info(`Starting new conversation session`);
                // After first message, subsequent messages will use -c flag
                this.claudeSessionId = 'active';
            } else {
                // One-shot mode (no conversation memory)
                command = `${catCommand} "${tempFile}" | claude -p - --model ${this.claudeModel} --max-turns ${this.claudeMaxTurns}`;
                logger.info(`Using one-shot mode (no conversation memory)`);
            }
            
            logger.info(`Running command: claude with prompt from file`);
            
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
                logger.debug(`Could not delete temp file: ${e.message}`);
            }
            
            if (stderr) {
                logger.error(`Claude stderr: ${stderr}`);
            }
            
            const response = stdout.trim();
            
            if (response) {
                logger.info(`Claude raw output length: ${response.length} chars`);
                return response;
            } else {
                logger.warn('Claude returned empty response');
                return null;
            }
        } catch (error) {
            // Try to clean up temp file on error
            try {
                await fs.unlink(tempFile);
            } catch (e) {
                // Ignore cleanup errors
            }
            
            logger.error(`Claude processing error: ${error.message}`);
            logger.error(`Error details: ${error.stack}`);
            
            if (error.message.includes('not found') || error.message.includes('is not recognized')) {
                return 'Error: Claude CLI not found. Please check installation.';
            }
            
            return `Sorry, I encountered an error processing your message: ${error.message}`;
        }
    }

    async run() {
        await this.initialize();
        
        logger.info('Starting message monitoring loop...');
        
        while (true) {
            try {
                const newMessages = await this.getNewMessages();
                
                for (const msg of newMessages) {
                    // Skip messages FROM the filtered user to prevent loops
                    if (this.filterMentions && msg.author.toLowerCase() === this.filterMentions.toLowerCase()) {
                        logger.debug(`Skipping message FROM ${this.filterMentions} to prevent loop`);
                        continue;
                    }
                    
                    logger.info(`New message from ${msg.author}: ${msg.content}`);
                    
                    // Process ALL messages with Claude
                    const response = await this.processWithClaude(msg);
                    
                    if (response) {
                        // Check if message mentions the filter target
                        const shouldSendToDiscord = !this.filterMentions || 
                            msg.content.toLowerCase().includes(this.filterMentions.toLowerCase()) ||
                            msg.content.includes(`@${this.filterMentions}`);
                        
                        if (this.testingMode || !shouldSendToDiscord) {
                            // Log to console only (testing mode OR no mention)
                            const reason = this.testingMode ? 'TESTING MODE' : 'NO MENTION';
                            logger.info(`==== CLAUDE RESPONSE (${reason} - NOT SENT) ====`);
                            logger.info(response);
                            logger.info('====================================================');
                        } else {
                            // Send to Discord (production mode AND has mention)
                            await this.page.waitForTimeout(this.responseDelay);
                            await this.sendMessage(response);
                            logger.info(`Sent response to Discord: ${response.substring(0, 100)}...`);
                        }
                    }
                }
                
                await this.page.waitForTimeout(2000);
                
            } catch (error) {
                logger.error(`Loop error: ${error.message}`);
                await this.page.waitForTimeout(5000);
            }
        }
    }

    async cleanup() {
        logger.info('Cleaning up...');
        if (this.browser) {
            await this.browser.close();
        }
    }
}

async function main() {
    const config = {
        discordEmail: process.env.DISCORD_EMAIL,
        discordPassword: process.env.DISCORD_PASSWORD,
        targetChannel: process.env.DISCORD_CHANNEL,
        botName: process.env.BOT_NAME || 'ClaudeAgent',
        responseDelay: parseInt(process.env.RESPONSE_DELAY) || 2000,
        claudeModel: process.env.CLAUDE_MODEL || 'sonnet',
        claudeMaxTurns: parseInt(process.env.CLAUDE_MAX_TURNS) || 5,
        skip2FA: process.env.SKIP_2FA === 'true',
        testingMode: process.env.TESTING_MODE === 'true',
        filterMentions: process.env.FILTER_MENTIONS || null,
        useConversationMode: process.env.USE_CONVERSATION_MODE !== 'false'  // Default to true
    };
    
    if (config.testingMode) {
        logger.info('🧪 TESTING MODE ENABLED - Responses will NOT be sent to Discord');
    }
    
    if (config.filterMentions) {
        logger.info(`📢 FILTER ENABLED - Processing all messages, but only responding in Discord to mentions of: ${config.filterMentions}`);
    }
    
    if (config.useConversationMode) {
        logger.info('💬 CONVERSATION MODE - Claude will remember context across messages');
    } else {
        logger.info('📝 ONE-SHOT MODE - Each message processed independently');
    }

    if (!config.discordEmail || !config.discordPassword || !config.targetChannel) {
        logger.error('Missing required environment variables. Please check your .env file.');
        logger.error('Required: DISCORD_EMAIL, DISCORD_PASSWORD, DISCORD_CHANNEL');
        process.exit(1);
    }

    const agent = new DiscordAgent(config);

    process.on('SIGINT', async () => {
        logger.info('Received shutdown signal...');
        await agent.cleanup();
        process.exit(0);
    });

    try {
        await agent.run();
    } catch (error) {
        logger.error(`Fatal error: ${error.message}`);
        await agent.cleanup();
        process.exit(1);
    }
}

main().catch(console.error);