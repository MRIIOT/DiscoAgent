const ClaudeAgent = require('./ClaudeAgent');
// Future: const GeminiAgent = require('./GeminiAgent');

class AgentFactory {
    static createAgent(type, config) {
        switch (type.toLowerCase()) {
            case 'claude':
                return new ClaudeAgent(config);
            // Future implementation:
            // case 'gemini':
            //     return new GeminiAgent(config);
            default:
                throw new Error(`Unknown agent type: ${type}`);
        }
    }

    static getAvailableAgents() {
        return ['claude']; // Add 'gemini' when implemented
    }
}

module.exports = AgentFactory;