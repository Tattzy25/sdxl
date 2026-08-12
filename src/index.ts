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

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);

  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

async function imageUrlToBytes(imageUrl: string): Promise<number[]> {
  const response = await fetch(imageUrl);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return Array.from(bytes);
}

async function generateImage(
  env: Env,
  prompt: string,
  negative_prompt: string | undefined,
  customer_id: string,
  image_url?: string
): Promise<string> {
  const hasImage = Boolean(image_url?.trim());

  const input: Record<string, unknown> = {
    prompt,
    negative_prompt,
    width: 1024,
    height: 1024,
    num_steps: 20,
    guidance: 7.5,
  };

  if (hasImage) {
    input.image = await imageUrlToBytes(image_url!);
    input.strength = 0.65;
  }

  const model = hasImage
    ? "@cf/runwayml/stable-diffusion-v1-5-img2img"
    : "@cf/stabilityai/stable-diffusion-xl-base-1.0";

  const result = await env.AI.run(model, input);

  const imageBytes = await streamToUint8Array(result as ReadableStream);

  const key = `${customer_id}${Math.floor(1000 + Math.random() * 9000)}.png`;

  await env.IMAGES.put(key, imageBytes, {
    httpMetadata: {
      contentType: "image/png",
    },
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
      description:
        "Generate an image from text, or edit an existing image when image_url is supplied",
      inputSchema: {
        prompt: z.string().min(1),
        negative_prompt: z.string().optional(),
        customer_id: z.string().min(1),
        image_url: z.string().url().optional().or(z.literal("")),
      },
    },
    async (params) => {
      const url = await generateImage(
        env,
        params.prompt,
        params.negative_prompt,
        params.customer_id,
        params.image_url
      );

      return {
        content: [
          {
            type: "text",
            text: url,
          },
        ],
      };
    }
  );

  return server;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/mcp")) {
      return createMcpHandler(() => createServer(env))(request, env, ctx);
    }

    if (url.pathname === "/generate") {
      const body = await request.json<{
        prompt: string;
        negative_prompt?: string;
        customer_id: string;
        image_url?: string;
      }>();

      const imageUrl = await generateImage(
        env,
        body.prompt,
        body.negative_prompt,
        body.customer_id,
        body.image_url
      );

      return new Response(imageUrl, {
        headers: {
          "content-type": "text/plain",
        },
      });
    }

    return new Response("Not found", {
      status: 404,
    });
  },
} satisfies ExportedHandler<Env>;
