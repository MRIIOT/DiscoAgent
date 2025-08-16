# Discord Agent - Claude Code Integration

A Node.js application that monitors Discord channels and uses Claude Code to generate intelligent responses.

## Setup Instructions

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

Required environment variables:
- `DISCORD_EMAIL`: Your Discord email
- `DISCORD_PASSWORD`: Your Discord password  
- `DISCORD_CHANNEL`: Channel name or full URL to monitor

### 3. Install Claude Code
Make sure Claude Code CLI is installed and accessible from command line:
```bash
claude --version
```

### 4. Run the Bot
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## How It Works

1. **Browser Automation**: Uses Playwright to control a browser instance logged into Discord
2. **Message Monitoring**: Continuously checks for new messages in the specified channel
3. **Claude Processing**: Sends messages to Claude Code via CLI for intelligent responses
4. **Response Posting**: Automatically posts Claude's responses back to Discord with format: `@username [$0.14] response text`

## Features

- Persistent browser session (stays logged in between restarts)
- Persistent Claude conversations (maintains context across bot restarts)
- Handles long messages (splits into chunks if needed)
- Comprehensive logging to console and file
- Graceful shutdown on Ctrl+C
- Configurable response delays and Claude model selection
- Configurable startup behavior (control how many messages to process on startup)
- Response formatting includes @mention, cost tracking, and Claude's response

## Security Notes

- Never commit your `.env` file
- Use strong, unique passwords
- Consider using a dedicated Discord account for the bot
- Monitor the `discoagent.log` file for any issues

## Configuration Options

### Startup Message Limit
Control how many messages the bot processes when it first starts:
- `STARTUP_MESSAGE_LIMIT=0` - Skip all existing messages (recommended for busy channels)
- `STARTUP_MESSAGE_LIMIT=3` - Process last 3 messages (default)
- `STARTUP_MESSAGE_LIMIT=-1` - Process all messages in channel history

### Session Persistence
The bot automatically maintains Claude conversation sessions across restarts:
- Sessions are stored in `claude-sessions.json` (excluded from git)
- Each Discord channel gets its own independent Claude session
- Invalid/expired sessions are automatically recreated
- Set `USE_CONVERSATION_MODE=false` to disable session persistence

## Troubleshooting

- **Login Issues**: Delete the `discord-session` folder to force a fresh login
- **Channel Not Found**: Use the full Discord URL instead of channel name
- **Claude Errors**: Check that Claude Code CLI is properly installed and authenticated
- **Rate Limiting**: Increase `RESPONSE_DELAY` in `.env` if getting rate limited
- **Too Many Messages on Startup**: Set `STARTUP_MESSAGE_LIMIT=0` to skip existing messages