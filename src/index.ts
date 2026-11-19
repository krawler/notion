import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Client as NotionClient } from "@notionhq/client"

const worker = new Worker()
export default worker

// Example agent tool that returns a greeting
// Delete this when you're ready to start building your own tools.
worker.tool("sayHello", {
  title: "Say Hello",
  description: "Returns a friendly greeting for the given name.",
  schema: j.object({
    name: j.string().describe("The name to greet."),
  }),
  execute: ({ name }) => `Hello, ${name}!`,
})

const MAX_CHARS = 50_000

// Lê recursivamente os blocos de uma página e devolve o texto simples.
async function readPageText(
  notion: NotionClient,
  blockId: string,
  depth = 0
): Promise<string> {
  const lines: string[] = []
  let cursor: string | undefined
  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    })
    for (const block of res.results) {
      if (!("type" in block)) continue
      const data = (block as Record<string, any>)[block.type]
      const rich = data?.rich_text as Array<{ plain_text: string }> | undefined
      if (rich?.length) {
        lines.push(rich.map((r) => r.plain_text).join(""))
      }
      if (block.has_children && depth < 3) {
        lines.push(await readPageText(notion, block.id, depth + 1))
      }
    }
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined
  } while (cursor)
  return lines.filter(Boolean).join("\n")
}

// Chama a tool de resumo no servidor MCP remoto.
async function summarizeViaMcp(text: string): Promise<string> {
  const url = process.env.MCP_SERVER_URL
  const toolName = process.env.MCP_SUMMARIZE_TOOL
  if (!url || !toolName) {
    throw new Error("Defina MCP_SERVER_URL e MCP_SUMMARIZE_TOOL.")
  }
  const argName = process.env.MCP_TEXT_ARG ?? "text"

  const headers: Record<string, string> = {}
  if (process.env.MCP_AUTH_TOKEN) {
    headers.Authorization = `Bearer ${process.env.MCP_AUTH_TOKEN}`
  }

  const client = new Client({ name: "notion-summarizer-worker", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  })
  await client.connect(transport)
  try {
    const result = await client.callTool({
      name: toolName,
      arguments: { [argName]: text },
    })
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>
    const out = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n")
    if (result.isError) throw new Error(`MCP retornou erro: ${out}`)
    return out
  } finally {
    await client.close()
  }
}

worker.tool("summarizePage", {
  title: "Resumir página",
  description:
    "Lê o conteúdo de uma página do Notion e devolve um resumo gerado por uma skill externa via MCP.",
  schema: j.object({
    pageId: j.string().describe("ID da página do Notion a resumir."),
  }),
  outputSchema: j.object({
    summary: j.string(),
    truncated: j.boolean(),
  }),
  execute: async ({ pageId }, { notion }) => {
    let text = await readPageText(notion, pageId)
    if (!text.trim()) throw new Error("A página não tem texto para resumir.")
    const truncated = text.length > MAX_CHARS
    if (truncated) text = text.slice(0, MAX_CHARS)
    const summary = await summarizeViaMcp(text)
    return { summary, truncated }
  },
})
