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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function generateImage(
  env: Env,
  prompt: string,
  negative_prompt: string | undefined,
  image_url: string | undefined
): Promise<string> {
  let image_b64: string | undefined;
  if (image_url) {
    const imgResp = await fetch(image_url);
    const imgBytes = await streamToUint8Array(imgResp.body as ReadableStream);
    image_b64 = bytesToBase64(imgBytes);
  }

  const result = await env.AI.run(
    "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    {
      prompt,
      negative_prompt,
      width: 1024,
      height: 1024,
      num_steps: 20,
      guidance: 7.5,
      ...(image_b64 ? { image_b64, strength: 0.65 } : {}),
    }
  );

  const imageBytes = await streamToUint8Array(result as ReadableStream);

  const key = `${Math.floor(1000 + Math.random() * 9000)}.png`;
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
        image_url: z.string().optional().describe("URL of an image to use as the base for img2img generation"),
      },
    },
    async (params) => {
      const url = await generateImage(env, params.prompt, params.negative_prompt, params.image_url);
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
      const body = await request.json<{ prompt: string; negative_prompt?: string; image_url?: string }>();
      const imageUrl = await generateImage(env, body.prompt, body.negative_prompt, body.image_url);
      return new Response(imageUrl, {
        headers: { "content-type": "text/plain" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
