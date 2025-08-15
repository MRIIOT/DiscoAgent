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
4. **Response Posting**: Automatically posts Claude's responses back to Discord

## Features

- Persistent browser session (stays logged in between restarts)
- Handles long messages (splits into chunks if needed)
- Comprehensive logging to console and file
- Graceful shutdown on Ctrl+C
- Configurable response delays and Claude model selection

## Security Notes

- Never commit your `.env` file
- Use strong, unique passwords
- Consider using a dedicated Discord account for the bot
- Monitor the `discoagent.log` file for any issues

## Troubleshooting

- **Login Issues**: Delete the `discord-session` folder to force a fresh login
- **Channel Not Found**: Use the full Discord URL instead of channel name
- **Claude Errors**: Check that Claude Code CLI is properly installed and authenticated
- **Rate Limiting**: Increase `RESPONSE_DELAY` in `.env` if getting rate limited