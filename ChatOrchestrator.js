class ChatOrchestrator {
    constructor(chatPlatform, aiAgent, logger, config = {}) {
        this.chatPlatform = chatPlatform;
        this.aiAgent = aiAgent;
        this.logger = logger;
        this.config = config;
        this.testingMode = config.testingMode || false;
        this.filterMentions = config.filterMentions || null;
        this.running = false;
    }

    async initialize() {
        this.logger.info('Initializing Chat Orchestrator...');
        
        // Initialize the chat platform
        await this.chatPlatform.initialize();
        
        // Initialize AI agent sessions
        await this.aiAgent.loadSessions();
        
        this.logger.info('Chat Orchestrator initialized successfully');
    }

    async processMessage(message) {
        try {
            this.logger.info(`Processing message from ${message.author}: ${message.content.substring(0, 50)}...`);
            
            // Process message with the AI agent
            const result = await this.aiAgent.processMessage(message);
            
            if (!result) {
                this.logger.warn('Agent returned null response');
                return null;
            }
            
            if (result.isError) {
                this.logger.error(`Agent error: ${result.result}`);
                return this.aiAgent.formatError(message.author, result.result);
            }
            
            // Format the response with author mention and cost
            const formattedResponse = this.aiAgent.formatResponse(
                message.author,
                result.cost || 0,
                result.result
            );
            
            this.logger.info(`Response cost: $${(result.cost || 0).toFixed(2)}`);
            return formattedResponse;
            
        } catch (error) {
            this.logger.error(`Message processing error: ${error.message}`);
            this.logger.error(`Error details: ${error.stack}`);
            
            return this.aiAgent.formatError(
                message.author,
                `Sorry, I encountered an error processing your message: ${error.message}`
            );
        }
    }

    shouldSendResponse(message) {
        // Check if message should trigger a response based on filter settings
        if (!this.filterMentions) {
            return true; // No filter, respond to all
        }
        
        // Check if message mentions the filter target
        return message.content.toLowerCase().includes(this.filterMentions.toLowerCase()) ||
               message.content.includes(`@${this.filterMentions}`);
    }

    async run() {
        this.logger.info('Starting orchestrator main loop...');
        this.running = true;
        
        while (this.running) {
            try {
                // Get new messages from the chat platform
                const newMessages = await this.chatPlatform.getNewMessages();
                
                // Mark startup complete after first fetch
                if (this.chatPlatform.markStartupComplete) {
                    await this.chatPlatform.markStartupComplete();
                }
                
                for (const msg of newMessages) {
                    // Skip messages from the bot itself
                    if (this.chatPlatform.isOwnMessage && this.chatPlatform.isOwnMessage(msg)) {
                        this.logger.debug(`Skipping own message`);
                        continue;
                    }
                    
                    // Skip messages FROM the filtered user to prevent feedback loops
                    // This prevents processing messages from the user we're supposed to respond to
                    if (this.filterMentions && msg.author.toLowerCase() === this.filterMentions.toLowerCase()) {
                        this.logger.info(`Skipping message FROM ${this.filterMentions} (feedback loop prevention)`);
                        continue;
                    }
                    
                    this.logger.info(`New message from ${msg.author}: ${msg.content}`);
                    
                    // Process ALL messages with AI agent (for context/learning)
                    const response = await this.processMessage(msg);
                    
                    if (response) {
                        // Check if we should send the response to Discord
                        const shouldRespond = this.shouldSendResponse(msg);
                        
                        if (this.testingMode || !shouldRespond) {
                            // Log to console only (testing mode OR no mention)
                            const reason = this.testingMode ? 'TESTING MODE' : 'NO MENTION';
                            this.logger.info(`==== AGENT RESPONSE (${reason} - NOT SENT) ====`);
                            this.logger.info(response);
                            this.logger.info('====================================================');
                        } else {
                            // Send response to chat platform
                            await this.chatPlatform.sendMessage(response);
                            this.logger.info(`Sent response: ${response.substring(0, 100)}...`);
                        }
                    }
                }
                
                // Wait before checking for new messages again
                await this.sleep(2000);
                
            } catch (error) {
                this.logger.error(`Orchestrator loop error: ${error.message}`);
                await this.sleep(5000);
            }
        }
    }

    async stop() {
        this.logger.info('Stopping orchestrator...');
        this.running = false;
    }

    async cleanup() {
        this.logger.info('Cleaning up orchestrator...');
        await this.stop();
        
        if (this.chatPlatform.cleanup) {
            await this.chatPlatform.cleanup();
        }
        
        if (this.aiAgent.cleanup) {
            await this.aiAgent.cleanup();
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = ChatOrchestrator;