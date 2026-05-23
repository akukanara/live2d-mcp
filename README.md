# Live2D MCP Controller

A system to control Live2D character expressions, motions, and voice via MCP (Model Context Protocol). While conversing with users, an LLM can invoke MCP tools in real-time to make the Live2D character speak, switch expressions, or play motions.

## Architecture

```
Your AI Agent / LLM Client
      │
      │  MCP Invocations (HTTP or stdio)
      ▼
MCP Server (Node.js :3000)
      │
      │  WebSocket (:8765)
      ▼
Live2D Renderer (Browser :5173)
```

## Quick Start

### Step 1: Download Required Assets

**1. Live2D Cubism Core**

Download it from the [Live2D Cubism SDK for Web](https://www.live2d.com/download/cubism-sdk/download-web/).
After extraction, locate `Core/live2dcubismcore.min.js` and copy it to the `renderer/public/` directory.

**2. HiyoriPro Model**

Download the HiyoriPro model from [Live2D Sample Data](https://www.live2d.com/en/download/sample-data/).
Extract and place the entire folder inside the `renderer/public/model/HiyoriPro/` directory.

Final directory structure:
```
renderer/public/
├── live2dcubismcore.min.js
└── model/
    └── HiyoriPro/
        ├── hiyori_pro_t11.model3.json
        └── ...
```

### Step 2: Install Dependencies and Start

```bash
# Install dependencies (only once)
npm install

# Start the MCP Server (HTTP mode)
cd mcp-server && npm run dev

# Open another terminal and start the renderer
cd renderer && npm run dev
```

Open your browser and navigate to http://localhost:5173. You should see the Live2D character rendered successfully.

### Step 3: Configure Your AI Client

Add the MCP server to your AI client/application configuration:

```json
{
  "mcpServers": {
    "live2d": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## MCP Tools List

| Tool | Description |
|------|-------------|
| `get_model_info` | Retrieve list of available expressions, motions, and parameters (Recommended to call first) |
| `set_expression` | Switch expression (happy/sad/angry, etc.) |
| `play_motion` | Play a motion animation (grouped by Idle/TapBody, etc.) |
| `look_at` | Control eye gaze direction (x/y: -1.0 to 1.0) |
| `set_parameter` | Fine-grain control of individual parameter (e.g., ParamMouthOpenY) |
| `reset` | Reset to default idle pose |
| `speak` | Synthesize speech using Tencent Cloud TTS + word-level timeline lip-sync |
| `lip_sync_estimate` | Lip-sync animation only, no audio playback (for use with external TTS) |
| `lip_sync` | Play specified audio and synchronize lips |

## TTS + Lip-Sync

Speech synthesis uses **Tencent Cloud TTS** (featuring the gentle voice tone "Xiaoning") with word-level timestamps to achieve precise lip-sync synchronization.

### Configure Tencent Cloud Credentials

```bash
export TENCENT_SECRET_ID="your_secret_id"
export TENCENT_SECRET_KEY="your_secret_key"

cd mcp-server && npm run dev
```

Credentials can be obtained from the [Tencent Cloud Console](https://console.cloud.tencent.com/cam/capi).

### Using the `speak` Tool

```typescript
await mcpClient.callTool("speak", {
  text: "Hello, I am Hiyori, nice to meet you!",
  emotion: "happy",   // neutral | happy | sad | angry | surprised
  speed: 1.0,         // 0.5 - 2.0
  voice_type: 603004  // Optional, defaults to 603004 (Xiaoning)
});
```

How Lip-Sync Works:
- Tencent Cloud TTS returns both audio and word-level timestamps.
- Each word mapped is converted to independent mouth opening/closing curves.
- Natural pauses and punctuation automatically keep the mouth closed, creating realistic speech rhythms.

### Lip-sync Animation Only (For External TTS Integration)

```typescript
await mcpClient.callTool("lip_sync_estimate", {
  text: "Hello!",
  emotion: "happy",
  speed: 1.0
});
```

## OpenClaw Integration

Add the MCP server configuration in `~/.openclaw/config.json`:

```json
{
  "mcpServers": {
    "live2d": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "env": {
        "TENCENT_SECRET_ID": "your_secret_id",
        "TENCENT_SECRET_KEY": "your_secret_key"
      }
    }
  }
}
```

Restart the OpenClaw gateway, and the AI will be able to control the Live2D character in real-time through the MCP tools.

### Recommended System Prompt Snippet

```
You control a Live2D virtual avatar and can use MCP tools to adjust its expression, play motions, and synthesize speech.
During conversations, call these tools proactively based on the emotion and content to make your character highly expressive.

- Call the 'speak' tool when replying, letting the character voice out and sync lips.
- Switch to appropriate expressions (happy, sad, angry, surprised) matching the conversation tone.
- Play relevant motion animations timely to enhance user interaction.
```

## Environment Variables

| Variable | Default Value | Description |
|------|--------|------|
| `TENCENT_SECRET_ID` | - | Tencent Cloud SecretId (Required for TTS) |
| `TENCENT_SECRET_KEY` | - | Tencent Cloud SecretKey (Required for TTS) |
| `HTTP_PORT` | 3000 | MCP HTTP Server Port |
| `WS_PORT` | 8765 | WebSocket Bridge Port |
