import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

export interface Env {
  AI: Fetcher;
  IMAGES: R2Bucket;
}

async function streamToUint8Array(stream: ReadableStream): Promise<Uint8Array> {
  const reader = stream.getReader();
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
  return merged;
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "stable-diffusion-xl",
    version: "1.0.0",
  });

  server.registerTool(
    "generate-image",
    {
      description: "Generate an image from a text prompt using Stable Diffusion XL",
      inputSchema: {
        prompt: z.string().min(1).describe("Text description of the image to generate"),
        negative_prompt: z.string().optional().describe("Elements to avoid in the image"),
        width: z.number().min(256).max(2048).default(1024).describe("Image width in pixels"),
        height: z.number().min(256).max(2048).default(1024).describe("Image height in pixels"),
        num_steps: z.number().max(20).default(20).describe("Diffusion steps (max 20)"),
        guidance: z.number().default(7.5).describe("How closely to follow the prompt"),
        seed: z.number().optional().describe("Random seed for reproducibility"),
      },
    },
    async (params) => {
      const result = await env.AI.run(
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

      const imageBytes = await streamToUint8Array(result as ReadableStream);

      const key = `${crypto.randomUUID()}.png`;
      await env.IMAGES.put(key, imageBytes, {
        httpMetadata: { contentType: "image/png" },
      });

      return {
        content: [{ type: "text", text: `https://imagine.tattty.com/${key}` }],
      };
    }
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // MCP endpoint
    if (url.pathname.startsWith("/mcp")) {
      return createMcpHandler(() => createServer(env))(request, env, ctx);
    }

    // Browser image endpoint at /
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
} satisfies ExportedHandler<Env>;
