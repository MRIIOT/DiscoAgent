const winston = require('winston');

class BaseAgent {
    constructor(config = {}) {
        this.config = config;
        this.sessionId = null;
        this.sessions = {};
        this.sessionFile = config.sessionFile || './agent-sessions.json';
        
        this.logger = winston.createLogger({
            level: process.env.DEBUG === 'true' ? 'debug' : 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.printf(({ timestamp, level, message }) => {
                    return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
                })
            ),
            transports: [
                new winston.transports.Console(),
                new winston.transports.File({ filename: 'agent.log' })
            ]
        });
    }

    /**
     * Process a message with the AI agent
     * @param {Object} message - Message object with author and content
     * @returns {Promise<Object>} Response object with result, cost, and session info
     */
    async processMessage(message) {
        throw new Error('processMessage must be implemented by subclass');
    }

    /**
     * Load saved sessions from disk
     */
    async loadSessions() {
        const fs = require('fs').promises;
        try {
            const data = await fs.readFile(this.sessionFile, 'utf8');
            this.sessions = JSON.parse(data);
            
            const channelKey = this.getChannelKey();
            if (this.sessions[channelKey]) {
                this.sessionId = this.sessions[channelKey];
                this.logger.info(`Loaded existing session for channel: ${this.sessionId}`);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                this.logger.error(`Error loading sessions: ${error.message}`);
            }
            this.sessions = {};
        }
    }

    /**
     * Save sessions to disk
     */
    async saveSessions() {
        const fs = require('fs').promises;
        try {
            await fs.writeFile(this.sessionFile, JSON.stringify(this.sessions, null, 2), 'utf8');
            this.logger.debug('Saved sessions to disk');
        } catch (error) {
            this.logger.error(`Error saving sessions: ${error.message}`);
        }
    }

    /**
     * Get a unique key for the current channel
     */
    getChannelKey() {
        const channel = this.config.targetChannel || 'default';
        return channel.replace(/[^a-zA-Z0-9]/g, '_');
    }

    /**
     * Format the response for Discord
     * @param {string} author - Message author
     * @param {number} cost - Cost in USD
     * @param {string} result - Response text
     * @returns {string} Formatted response
     */
    formatResponse(author, cost, result) {
        const costStr = cost ? `$${cost.toFixed(2)}` : '$0.00';
        return `@${author} [${costStr}] ${result}`;
    }

    /**
     * Format an error response
     * @param {string} author - Message author
     * @param {string} error - Error message
     * @returns {string} Formatted error response
     */
    formatError(author, error) {
        return `@${author} Error: ${error}`;
    }
}

module.exports = BaseAgent;