const { chromium } = require('playwright');
const winston = require('winston');
const AgentFactory = require('./agents/AgentFactory');

class DiscordAgent {
    constructor(config, logger) {
        this.config = config;  // Store the full config for later use
        this.logger = logger;
        this.discordEmail = config.discordEmail;
        this.discordPassword = config.discordPassword;
        this.targetChannel = config.targetChannel;
        this.browser = null;
        this.page = null;
        this.lastMessageId = null;
        this.lastKnownAuthor = null;  // Track the last known author
        this.botName = config.botName || 'ClaudeAgent';
        this.responseDelay = config.responseDelay || 2000;
        this.skip2FA = config.skip2FA || false;
        this.testingMode = config.testingMode || false;
        this.filterMentions = config.filterMentions || null;
        this.isStartup = true;  // Track if this is the first message fetch after startup
        this.startupMessageLimit = config.startupMessageLimit !== undefined ? config.startupMessageLimit : 3; // Default to 3, can be set to 0
        this.lastMessageAuthor = null;  // Track the last message author for response formatting
        
        // AI Agent configuration
        this.agentType = config.agentType || 'claude';  // Default to Claude
        this.agent = null;  // Will be initialized in initialize()
    }

    async initialize() {
        this.logger.info('Initializing Discord Agent...');
        this.logger.info('Browser launch configuration: headless=false, persistent session=./discord-session');
        
        // Initialize the AI agent
        this.agent = AgentFactory.createAgent(this.agentType, {
            ...this.config,
            targetChannel: this.targetChannel,
            logger: this.logger
        });
        await this.agent.loadSessions();
        
        try {
            const context = await chromium.launchPersistentContext('./discord-session', {
                headless: false,
                viewport: { width: 1280, height: 720 }
            });
            this.logger.info('Browser context created successfully');
            
            this.browser = context;
            
            // Check if there are existing pages
            const pages = context.pages();
            if (pages.length > 0) {
                this.logger.info(`Found ${pages.length} existing page(s), using first one`);
                this.page = pages[0];
            } else {
                this.logger.info('Creating new page');
                this.page = await context.newPage();
            }
            
            // Check current URL before navigation
            const startUrl = this.page.url();
            this.logger.info(`Starting URL: ${startUrl}`);
            
            // If we're already on Discord and logged in, don't navigate
            if (startUrl.includes('discord.com') && startUrl.includes('channels')) {
                this.logger.info('Already on Discord channels page, skipping navigation');
            } else {
                this.logger.info('Navigating to Discord app...');
                await this.page.goto('https://discord.com/app', { waitUntil: 'domcontentloaded' });
                this.logger.info(`Page loaded. Current URL: ${this.page.url()}`);
                
                // Wait a bit for any redirects
                await this.page.waitForTimeout(3000);
            }
            
            const currentUrl = this.page.url();
            this.logger.info(`After redirect check - Current URL: ${currentUrl}`);
            
            // Check if we need to login
            if (currentUrl.includes('login')) {
                this.logger.info('Login page detected, proceeding with authentication');
                await this.login();
            } else if (currentUrl.includes('channels')) {
                this.logger.info('Already logged in, found channels in URL');
            } else {
                this.logger.info(`Checking login state at URL: ${currentUrl}`);
                
                // Wait a bit longer for page to fully load
                await this.page.waitForTimeout(2000);
                
                // Try multiple ways to detect if we're logged in
                const loggedInIndicators = [
                    this.page.locator('[data-list-id="channels"]').first(),
                    this.page.locator('[class*="sidebar"]').first(),
                    this.page.locator('[aria-label*="Server"]').first(),
                    this.page.locator('[role="navigation"]').first()
                ];
                
                let isLoggedIn = false;
                for (const indicator of loggedInIndicators) {
                    try {
                        if (await indicator.isVisible({ timeout: 2000 })) {
                            isLoggedIn = true;
                            this.logger.info(`Found logged-in indicator: ${await indicator.evaluate(el => el.tagName + '.' + el.className)}`);
                            break;
                        }
                    } catch (e) {
                        // Continue checking other indicators
                    }
                }
                
                if (isLoggedIn) {
                    this.logger.info('Successfully detected logged-in state');
                } else {
                    this.logger.info('No logged-in indicators found - navigating to login page');
                    await this.page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
                    
                    // Double-check if we actually need to login
                    await this.page.waitForTimeout(2000);
                    const loginUrl = this.page.url();
                    
                    if (loginUrl.includes('channels')) {
                        this.logger.info('Redirected to channels - already logged in!');
                    } else if (loginUrl.includes('login')) {
                        this.logger.info('Confirmed on login page - proceeding with authentication');
                        await this.login();
                    } else {
                        this.logger.warn(`Unexpected state after login navigation: ${loginUrl}`);
                        // Try to proceed anyway
                    }
                }
            }
            
            // Try to navigate to channel
            try {
                await this.navigateToChannel();
                this.logger.info(`Successfully connected to channel: ${this.targetChannel}`);
            } catch (navError) {
                this.logger.error(`Failed to navigate to channel: ${navError.message}`);
                
                // Last resort - try direct navigation if we have a URL
                if (this.targetChannel.startsWith('http')) {
                    this.logger.info('Attempting direct navigation to channel URL...');
                    await this.page.goto(this.targetChannel, { waitUntil: 'domcontentloaded' });
                    await this.page.waitForTimeout(3000);
                } else {
                    throw navError;
                }
            }
            
        } catch (error) {
            this.logger.error(`Initialization error: ${error.message}`);
            throw error;
        }
    }

    async login() {
        this.logger.info('Starting login process...');
        this.logger.info(`Login URL: ${this.page.url()}`);
        
        try {
            // First check if we're actually on the login page
            const currentUrl = this.page.url();
            if (!currentUrl.includes('login')) {
                this.logger.info('Not on login page, checking if already logged in...');
                if (currentUrl.includes('channels')) {
                    this.logger.info('Already logged in (URL contains channels)');
                    return;
                }
            }
            
            // Wait for login form to be visible
            this.logger.info('Waiting for email input field...');
            
            try {
                await this.page.waitForSelector('input[name="email"]', { timeout: 5000 });
                this.logger.info('Email input field found');
            } catch (timeoutError) {
                // Check if we got redirected while waiting
                const newUrl = this.page.url();
                if (newUrl.includes('channels')) {
                    this.logger.info('Redirected to channels during login wait - already logged in');
                    return;
                }
                throw timeoutError;
            }
            
            // Check if password field is also present
            const hasPasswordField = await this.page.locator('input[name="password"]').count() > 0;
            this.logger.info(`Password field present: ${hasPasswordField}`);
            
            // Fill email field
            this.logger.info(`Entering email: ${this.discordEmail.substring(0, 3)}***`);
            await this.page.fill('input[name="email"]', this.discordEmail);
            
            // Fill password field
            this.logger.info('Entering password...');
            await this.page.fill('input[name="password"]', this.discordPassword);
            
            // Find and click the Log In button
            this.logger.info('Looking for Log In button...');
            const submitButton = await this.page.locator('button[type="submit"]');
            const buttonText = await submitButton.textContent();
            this.logger.info(`Found submit button with text: "${buttonText}"`);
            
            this.logger.info('Clicking Log In button...');
            await submitButton.click();
            
            // Wait for navigation or response
            this.logger.info('Waiting for login response...');
            
            // Wait for either channels to load, 2FA prompt, or error message
            const result = await Promise.race([
                this.page.waitForSelector('[data-list-id="channels"]', { timeout: 30000 }).then(() => 'channels'),
                this.page.waitForSelector('[aria-label*="Auth" i], [aria-label*="2FA" i], [aria-label*="code" i]', { timeout: 30000 }).then(() => '2fa'),
                this.page.waitForSelector('[class*="error" i], [class*="invalid" i]', { timeout: 5000 }).then(() => 'error'),
                this.page.waitForTimeout(30000).then(() => 'timeout')
            ]);
            
            this.logger.info(`Login result: ${result}`);
            
            if (result === 'error') {
                const errorText = await this.page.locator('[class*="error" i], [class*="invalid" i]').first().textContent();
                this.logger.error(`Login error detected: ${errorText}`);
                throw new Error(`Login failed: ${errorText}`);
            }
            
            if (result === '2fa') {
                if (this.skip2FA) {
                    this.logger.warn('2FA detected but SKIP_2FA is enabled - attempting to proceed anyway');
                    // Try to proceed without waiting for 2FA
                    await this.page.waitForTimeout(3000);
                } else {
                    this.logger.warn('2FA authentication required. Please enter code manually in the browser window.');
                    this.logger.info('Waiting up to 2 minutes for 2FA completion...');
                    this.logger.info('(Set SKIP_2FA=true in .env to skip this wait if already authenticated)');
                    await this.page.waitForSelector('[data-list-id="channels"]', { timeout: 120000 });
                    this.logger.info('2FA completed successfully');
                }
            }
            
            if (result === 'timeout') {
                this.logger.error('Login timeout - no response after 30 seconds');
                throw new Error('Login timeout');
            }
            
            // Final check - make sure we're logged in
            const finalUrl = this.page.url();
            this.logger.info(`Post-login URL: ${finalUrl}`);
            
            if (finalUrl.includes('channels')) {
                this.logger.info('Login successful - channels URL confirmed');
            } else {
                this.logger.warn(`Unexpected post-login URL: ${finalUrl}`);
            }
            
        } catch (error) {
            this.logger.error(`Login error: ${error.message}`);
            
            // Take a screenshot for debugging
            try {
                await this.page.screenshot({ path: 'login-error.png' });
                this.logger.info('Screenshot saved as login-error.png');
            } catch (screenshotError) {
                this.logger.error('Could not save screenshot');
            }
            
            throw error;
        }
    }


    async navigateToChannel() {
        this.logger.info(`Attempting to navigate to channel: ${this.targetChannel}`);
        
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
                        this.logger.info(`Clicked channel using selector: ${selector}`);
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
        this.logger.info(`Found ${textboxCount} textbox elements on page`);
        
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
                    this.logger.info(`Found message input with selector: ${selector}`);
                    
                    // Click on it to make sure it's focused
                    await element.click();
                    break;
                }
            } catch (e) {
                this.logger.debug(`Selector failed: ${selector}`);
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
                    this.logger.info('Found textbox with attributes:', JSON.stringify(attrs));
                }
            } catch (e) {
                this.logger.error('No textbox elements found at all');
            }
            
            throw new Error('Could not find message input field');
        }
    }

    async getNewMessages() {
        const messages = await this.page.evaluate(() => {
            const messageElements = document.querySelectorAll('[id^="message-content-"]');
            const messageList = [];
            
            messageElements.forEach(el => {
                // Skip if this is a reply preview content
                if (el.classList.contains('repliedTextContent_c19a55')) {
                    return;
                }
                
                // Try multiple ways to find the message container and author
                const messageContainer = el.closest('[id^="chat-messages-"]') || 
                                       el.closest('[class*="message-"]') || 
                                       el.closest('[class*="message"]') ||
                                       el.closest('li');
                
                // Debug logging
                const debugInfo = {
                    messageId: el.id,
                    containerFound: !!messageContainer,
                    containerClasses: messageContainer?.className || 'none',
                    containerId: messageContainer?.id || 'none'
                };
                
                // Try to find the actual message author (not the replied-to user)
                let author = 'Unknown';
                if (messageContainer) {
                    // Method 1: Look for username element with specific ID pattern
                    const usernameById = messageContainer.querySelector('[id^="message-username-"] .username_c19a55');
                    if (usernameById && !usernameById.closest('.repliedMessage_c19a55')) {
                        author = usernameById.textContent.trim();
                        debugInfo.method1 = `Found by ID: ${author}`;
                    }
                    
                    // Method 2: If that fails, look in the header
                    if (author === 'Unknown') {
                        const headerElement = messageContainer.querySelector('.header_c19a55');
                        if (headerElement) {
                            const usernameInHeader = headerElement.querySelector('.username_c19a55');
                            if (usernameInHeader && !usernameInHeader.closest('.repliedMessage_c19a55')) {
                                author = usernameInHeader.textContent.trim();
                                debugInfo.method2 = `Found in header: ${author}`;
                            } else {
                                debugInfo.method2 = 'Header found but no username';
                            }
                        } else {
                            debugInfo.method2 = 'No header found';
                        }
                    }
                    
                    // Method 3: Look for any span with username class
                    if (author === 'Unknown') {
                        const allUsernames = messageContainer.querySelectorAll('.username_c19a55');
                        debugInfo.usernameCount = allUsernames.length;
                        for (const elem of allUsernames) {
                            // Skip if it's inside reply context
                            if (!elem.closest('.repliedMessage_c19a55')) {
                                const text = elem.textContent.trim();
                                // Skip if it's a mention (starts with @)
                                if (text && !text.startsWith('@')) {
                                    author = text;
                                    debugInfo.method3 = `Found username: ${author}`;
                                    break;
                                }
                            }
                        }
                    }
                    
                    // Method 4: Look for any element with aria-label containing username
                    if (author === 'Unknown') {
                        const ariaLabels = messageContainer.querySelectorAll('[aria-label]');
                        for (const elem of ariaLabels) {
                            const label = elem.getAttribute('aria-label');
                            if (label && label.includes('username')) {
                                author = elem.textContent.trim() || label.split(',')[0].trim();
                                if (author && author !== 'Unknown') {
                                    debugInfo.method4 = `Found by aria-label: ${author}`;
                                    break;
                                }
                            }
                        }
                    }
                    
                    // Method 5: Look for author in message header without specific class
                    if (author === 'Unknown') {
                        const possibleHeaders = messageContainer.querySelectorAll('h3, [class*="username"], [class*="author"], [class*="name"]');
                        for (const elem of possibleHeaders) {
                            if (!elem.closest('.repliedMessage_c19a55') && !elem.closest('[class*="reply"]')) {
                                const text = elem.textContent.trim();
                                if (text && !text.startsWith('@') && text.length < 50) { // Reasonable username length
                                    author = text;
                                    debugInfo.method5 = `Found by class pattern: ${author}`;
                                    break;
                                }
                            }
                        }
                    }
                    
                    // Method 6: Look for img alt text (avatar username)
                    if (author === 'Unknown') {
                        const avatarImg = messageContainer.querySelector('img[alt]');
                        if (avatarImg) {
                            const altText = avatarImg.getAttribute('alt');
                            if (altText && altText.length < 50 && !altText.includes('avatar')) {
                                author = altText;
                                debugInfo.method6 = `Found by avatar alt: ${author}`;
                            }
                        }
                    }
                    
                    // Method 7: Look for any h3 element (Discord often uses h3 for usernames)
                    if (author === 'Unknown') {
                        const h3Elements = messageContainer.querySelectorAll('h3');
                        for (const h3 of h3Elements) {
                            const text = h3.textContent.trim();
                            if (text && text.length < 50 && !text.startsWith('@')) {
                                author = text;
                                debugInfo.method7 = `Found in h3: ${author}`;
                                break;
                            }
                        }
                    }
                    
                    // Log debugging info
                    if (author === 'Unknown') {
                        console.log('Failed to find author. Debug info:', JSON.stringify(debugInfo));
                        // Log all classes in container for analysis
                        const allClasses = Array.from(messageContainer.querySelectorAll('*'))
                            .map(e => e.className)
                            .filter(c => c && c.includes('username') || c.includes('author') || c.includes('name'))
                            .slice(0, 5);
                        console.log('Username-related classes found:', allClasses);
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

        // Log raw messages for debugging
        if (messages.length > 0) {
            this.logger.debug(`Retrieved ${messages.length} total messages from page`);
            // Log the last few messages for debugging
            const recentMessages = messages.slice(-3);
            recentMessages.forEach(msg => {
                this.logger.debug(`Message ${msg.id}: Author="${msg.author}", Content="${msg.content.substring(0, 50)}..."`);
            });
        }
        
        // On startup, trace back to find the last known author
        // This helps with continuation messages that don't show usernames
        if (!this.lastKnownAuthor && messages.length > 0) {
            this.logger.info('No last known author, tracing back through messages to find one...');
            // Go through messages in reverse to find the most recent author
            for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i];
                if (msg.author && msg.author !== 'Unknown' && msg.author !== this.botName) {
                    this.lastKnownAuthor = msg.author;
                    this.logger.info(`Found last known author by tracing back: ${this.lastKnownAuthor}`);
                    break;
                }
            }
            
            if (!this.lastKnownAuthor) {
                this.logger.warn('Could not find any valid author in message history');
            }
        }
        
        // Now apply the lastKnownAuthor to any Unknown messages
        // This handles continuation messages that don't have author elements
        if (this.lastKnownAuthor) {
            for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];
                if (msg.author === 'Unknown') {
                    // Check if previous message has a known author
                    if (i > 0 && messages[i-1].author !== 'Unknown' && messages[i-1].author !== this.botName) {
                        msg.author = messages[i-1].author;
                        this.logger.debug(`Applied author from previous message: ${msg.author}`);
                    } else {
                        // Use the last known author
                        msg.author = this.lastKnownAuthor;
                        this.logger.debug(`Applied last known author to Unknown message: ${this.lastKnownAuthor}`);
                    }
                } else if (msg.author !== 'Unknown' && msg.author !== this.botName) {
                    // Update last known author as we go through messages
                    this.lastKnownAuthor = msg.author;
                }
            }
        }
        
        const newMessages = [];
        let foundLast = !this.lastMessageId;
        
        // If this is startup and we have no lastMessageId, limit messages based on config
        if (this.isStartup && !this.lastMessageId && this.startupMessageLimit >= 0 && messages.length > this.startupMessageLimit) {
            if (this.startupMessageLimit === 0) {
                this.logger.info(`Startup mode: Skipping all ${messages.length} existing messages (STARTUP_MESSAGE_LIMIT=0)`);
                // Don't process any messages, just update lastMessageId
            } else {
                this.logger.info(`Startup mode: Limiting initial processing to last ${this.startupMessageLimit} messages out of ${messages.length} total`);
                // Get only the last N messages
                const startIndex = messages.length - this.startupMessageLimit;
                for (let i = startIndex; i < messages.length; i++) {
                    const msg = messages[i];
                    
                    // Author has already been resolved in the preprocessing step
                    if (msg.author !== this.botName && msg.content && msg.content.length > 0) {
                        newMessages.push(msg);
                    }
                }
            }
        } else if (this.isStartup && !this.lastMessageId && this.startupMessageLimit < 0) {
            // Negative value means process all messages on startup
            this.logger.info(`Startup mode: Processing all ${messages.length} messages (STARTUP_MESSAGE_LIMIT=${this.startupMessageLimit})`);
            for (const msg of messages) {
                // Author has already been resolved in the preprocessing step
                if (msg.author !== this.botName && msg.content && msg.content.length > 0) {
                    newMessages.push(msg);
                }
            }
        } else {
            // Normal operation: process all new messages after lastMessageId
            for (const msg of messages) {
                if (!foundLast) {
                    if (msg.id === this.lastMessageId) {
                        foundLast = true;
                    }
                    continue;
                }
                
                // Author has already been resolved in the preprocessing step
                if (msg.author !== this.botName && msg.content && msg.content.length > 0) {
                    newMessages.push(msg);
                }
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

    async processWithAgent(message) {
        // Store the message author for response formatting
        this.lastMessageAuthor = message.author;
        
        try {
            this.logger.info(`Processing message with ${this.agentType}: ${message.content.substring(0, 50)}...`);
            
            // Process message with the AI agent
            const result = await this.agent.processMessage(message);
            
            if (!result) {
                this.logger.warn('Agent returned null response');
                return null;
            }
            
            if (result.isError) {
                this.logger.error(`Agent error: ${result.result}`);
                return this.agent.formatError(message.author, result.result);
            }
            
            // Format the response with author mention and cost
            const formattedResponse = this.agent.formatResponse(
                message.author,
                result.cost || 0,
                result.result
            );
            
            this.logger.info(`Response cost: $${(result.cost || 0).toFixed(2)}`);
            return formattedResponse;
            
        } catch (error) {
            this.logger.error(`Agent processing error: ${error.message}`);
            this.logger.error(`Error details: ${error.stack}`);
            
            return this.agent.formatError(
                message.author,
                `Sorry, I encountered an error processing your message: ${error.message}`
            );
        }
    }

    async run() {
        await this.initialize();
        
        this.logger.info('Starting message monitoring loop...');
        
        while (true) {
            try {
                const newMessages = await this.getNewMessages();
                
                // After the first message fetch, disable startup mode
                if (this.isStartup) {
                    this.isStartup = false;
                    this.logger.info('Startup message processing complete. Switching to normal operation mode.');
                }
                
                for (const msg of newMessages) {
                    // Skip messages FROM the filtered user to prevent loops
                    if (this.filterMentions && msg.author.toLowerCase() === this.filterMentions.toLowerCase()) {
                        this.logger.debug(`Skipping message FROM ${this.filterMentions} to prevent loop`);
                        continue;
                    }
                    
                    this.logger.info(`New message from ${msg.author}: ${msg.content}`);
                    
                    // Process ALL messages with the AI agent
                    const response = await this.processWithAgent(msg);
                    
                    if (response) {
                        // Check if message mentions the filter target
                        const shouldSendToDiscord = !this.filterMentions || 
                            msg.content.toLowerCase().includes(this.filterMentions.toLowerCase()) ||
                            msg.content.includes(`@${this.filterMentions}`);
                        
                        if (this.testingMode || !shouldSendToDiscord) {
                            // Log to console only (testing mode OR no mention)
                            const reason = this.testingMode ? 'TESTING MODE' : 'NO MENTION';
                            this.logger.info(`==== AGENT RESPONSE (${reason} - NOT SENT) ====`);
                            this.logger.info(response);
                            this.logger.info('====================================================');
                        } else {
                            // Send to Discord (production mode AND has mention)
                            await this.page.waitForTimeout(this.responseDelay);
                            await this.sendMessage(response);
                            this.logger.info(`Sent response to Discord: ${response.substring(0, 100)}...`);
                        }
                    }
                }
                
                await this.page.waitForTimeout(2000);
                
            } catch (error) {
                this.logger.error(`Loop error: ${error.message}`);
                await this.page.waitForTimeout(5000);
            }
        }
    }

    async cleanup() {
        this.logger.info('Cleaning up...');
        if (this.browser) {
            await this.browser.close();
        }
    }
}

module.exports = DiscordAgent;