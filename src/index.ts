import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

// ── MCP Server (for AI clients like Claude Desktop, Cursor) ──
export class ImageGenServer extends McpAgent {
  server = new McpServer({
    name: "stable-diffusion-xl",
    version: "1.0.0",
  });

  async init() {
    this.server.tool(
      "generate-image",
      "Generate an image from a text prompt using Stable Diffusion XL",
      {
        prompt: z.string().min(1).describe("Text description of the image to generate"),
        negative_prompt: z.string().optional().describe("Elements to avoid"),
        width: z.number().min(256).max(2048).default(1024),
        height: z.number().min(256).max(2048).default(1024),
        num_steps: z.number().max(20).default(20),
        guidance: z.number().default(7.5),
        seed: z.number().optional(),
      },
      async (params) => {
        const result = await this.env.AI.run(
          "@cf/stabilityai/stable-diffusion-xl-base-1.0",
          {
            prompt: params.prompt,
            negative_prompt: params.negative_prompt,
            width: params.width,
            height: params.height,
            num_steps: params.num_steps,
            guidance: params.guidance,
            seed: params.seed,
          }
        );

        // Convert ReadableStream to base64 for MCP
        const reader = (result as ReadableStream).getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const total = chunks.reduce((a, c) => a + c.length, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        const base64 = btoa(String.fromCharCode(...merged));

        return {
          content: [{ type: "image", data: base64, mimeType: "image/png" }],
        };
      }
    );
  }
}

// ── Mount the MCP server at /mcp (no auth) ──
const mcpHandler = ImageGenServer.mount("/mcp");

// ── Default export: routes /mcp to MCP, everything else to image endpoint ──
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Route MCP traffic to the MCP server
    if (url.pathname.startsWith("/mcp")) {
      return mcpHandler.fetch(request, env, { waitUntil: () => {} });
    }

    // Otherwise, serve the image directly in the browser
    const prompt = url.searchParams.get("prompt") ?? "a cat in space, digital art";

    const result = await env.AI.run(
      "@cf/stabilityai/stable-diffusion-xl-base-1.0",
      {
        prompt,
        negative_prompt: "blurry, low quality",
        width: 1024,
        height: 1024,
        num_steps: 20,
        guidance: 7.5,
      }
    );

    return new Response(result, {
      headers: { "content-type": "image/png" },
    });
  },
};
