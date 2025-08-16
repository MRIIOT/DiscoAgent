const winston = require('winston');
const DiscordAgent = require('./DiscordAgent');
require('dotenv').config();

const logger = winston.createLogger({
    level: process.env.DEBUG === 'true' ? 'debug' : 'info',
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

async function main() {
    const config = {
        discordEmail: process.env.DISCORD_EMAIL,
        discordPassword: process.env.DISCORD_PASSWORD,
        targetChannel: process.env.DISCORD_CHANNEL,
        botName: process.env.BOT_NAME || 'ClaudeAgent',
        responseDelay: parseInt(process.env.RESPONSE_DELAY) || 2000,
        
        // Agent configuration
        agentType: process.env.AGENT_TYPE || 'claude',  // 'claude' or 'gemini' (future)
        claudeModel: process.env.CLAUDE_MODEL || 'sonnet',
        claudeMaxTurns: parseInt(process.env.CLAUDE_MAX_TURNS) || 5,
        
        skip2FA: process.env.SKIP_2FA === 'true',
        testingMode: process.env.TESTING_MODE === 'true',
        filterMentions: process.env.FILTER_MENTIONS || null,
        useConversationMode: process.env.USE_CONVERSATION_MODE !== 'false',  // Default to true
        startupMessageLimit: process.env.STARTUP_MESSAGE_LIMIT !== undefined ? parseInt(process.env.STARTUP_MESSAGE_LIMIT) : 0  // Default to 0, can be 0 to skip all, or -1 to process all
    };
    
    // Log agent type
    logger.info(`🤖 AGENT TYPE: ${config.agentType.toUpperCase()}`);
    
    if (config.testingMode) {
        logger.info('🧪 TESTING MODE ENABLED - Responses will NOT be sent to Discord');
    }
    
    if (config.filterMentions) {
        logger.info(`📢 FILTER ENABLED - Processing all messages, but only responding in Discord to mentions of: ${config.filterMentions}`);
    }
    
    if (config.useConversationMode) {
        logger.info('💬 CONVERSATION MODE - Agent will remember context across messages');
    } else {
        logger.info('📝 ONE-SHOT MODE - Each message processed independently');
    }
    
    // Log startup message limit configuration
    if (config.startupMessageLimit === 0) {
        logger.info('🚀 STARTUP: Will skip all existing messages (STARTUP_MESSAGE_LIMIT=0)');
    } else if (config.startupMessageLimit < 0) {
        logger.info('🚀 STARTUP: Will process ALL existing messages (STARTUP_MESSAGE_LIMIT<0)');
    } else {
        logger.info(`🚀 STARTUP: Will process last ${config.startupMessageLimit} messages (STARTUP_MESSAGE_LIMIT=${config.startupMessageLimit})`);
    }

    if (!config.discordEmail || !config.discordPassword || !config.targetChannel) {
        logger.error('Missing required environment variables. Please check your .env file.');
        logger.error('Required: DISCORD_EMAIL, DISCORD_PASSWORD, DISCORD_CHANNEL');
        process.exit(1);
    }

    const agent = new DiscordAgent(config, logger);

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