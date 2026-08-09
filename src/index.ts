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

async function generateImage(env: Env, prompt: string, negative_prompt: string | undefined, customer_id: string): Promise<string> {
  const result = await env.AI.run(
    "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    {
      prompt,
      negative_prompt,
      width: 1024,
      height: 1024,
      num_steps: 20,
      guidance: 7.5,
    }
  );

  const imageBytes = await streamToUint8Array(result as ReadableStream);

  const key = `${customer_id}${Math.floor(1000 + Math.random() * 9000)}.png`;
  await env.IMAGES.put(key, imageBytes, {
    httpMetadata: { contentType: "image/png" },
  });

  return `https://imagine.tattty.com/${key}`;
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
        customer_id: z.string().min(1).describe("Customer ID used to namespace the stored image"),
      },
    },
    async (params) => {
      const url = await generateImage(env, params.prompt, params.negative_prompt, params.customer_id);
      return {
        content: [{ type: "text", text: url }],
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

    // Plain HTTP endpoint — returns ONLY the image URL as raw text
    if (url.pathname === "/generate") {
      const body = await request.json<{ prompt: string; negative_prompt?: string; customer_id: string }>();
      const imageUrl = await generateImage(env, body.prompt, body.negative_prompt, body.customer_id);
      return new Response(imageUrl, {
        headers: { "content-type": "text/plain" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;