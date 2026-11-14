import "dotenv/config";
import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.PORT) || 3000;
const directory = path.dirname(fileURLToPath(import.meta.url));
const maxMessages = 40;
const maxMessageLength = 4000;
const maxConversationLength = 20000;
const researchRuns = new Map();
const tinyFishSearchUrl = "https://api.search.tinyfish.ai";
const tinyFishResearchUrl = "https://agent.tinyfish.ai/v1/automation/run-research-async";
const tinyFishRunsUrl = "https://agent.tinyfish.ai/v1/research-run";

function classifyRequest(query) {
  const normalizedQuery = query.trim().toLocaleLowerCase("th");
  const isGreeting = /^(สวัสดี(?:ครับ|ค่ะ)?|หวัดดี(?:ครับ|ค่ะ)?|ขอบคุณ(?:ครับ|ค่ะ)?|ขอบใจ(?:ครับ|ค่ะ)?|โอเค|ok|hello|hi)[.!?\s]*$/i.test(normalizedQuery);
  if (isGreeting) return "greeting";

  const needsResearch = /ค้นคว้า|วิจัย|deep research|วิเคราะห์|เปรียบเทียบ|ข้อดี.{0,30}ข้อเสีย|หลายด้าน|รายงาน|สรุปข่าว|ข่าว.*(?:ล่าสุด|วันนี้|สัปดาห์|เดือน)|(?:ล่าสุด|วันนี้|ย้อนหลัง)\s*\d*\s*(?:วัน|สัปดาห์|เดือน)|อ้างอิง|แหล่งที่มา|เชิงลึก|เจาะลึก|benchmark/i.test(normalizedQuery);
  const listItems = normalizedQuery.match(/(?:^|\n)\s*(?:\d+[.)]|[-*•])\s/gm) || [];
  return needsResearch || normalizedQuery.length > 180 || listItems.length >= 2 ? "research" : "search";
}

function formatSearchResults(query, results) {
  if (results.length === 0) return `ยังไม่พบผลค้นหาสำหรับ “${query}” ลองปรับคำถามแล้วค้นหาอีกครั้งครับ`;

  const summaries = results.map((item, index) => {
    const title = item.title || item.site_name || item.url;
    const snippet = item.snippet || item.url;
    return `${index + 1}. ${title}\n${snippet}`;
  });
  return `ผลค้นหาเบื้องต้นสำหรับ “${query}”\n\n${summaries.join("\n\n")}\n\nนี่คือผลค้นหาและ snippets จากเว็บ ยังไม่ได้สังเคราะห์เป็นรายงานเชิงลึกครับ`;
}

app.disable("x-powered-by");
app.use(express.json({ limit: "128kb" }));

app.get("/", (_request, response) => {
  response.sendFile(path.join(directory, "index.html"));
});

app.get("/style.css", (_request, response) => {
  response.sendFile(path.join(directory, "style.css"));
});

app.get("/script.js", (_request, response) => {
  response.sendFile(path.join(directory, "script.js"));
});

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, provider: "tinyfish", configured: Boolean(process.env.TINYFISH_API_KEY?.trim()) });
});

app.post("/api/chat", async (request, response) => {
  const { messages } = request.body ?? {};
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > maxMessages) {
    return response.status(400).json({ error: "รูปแบบบทสนทนาไม่ถูกต้อง" });
  }

  const validMessages = messages.every((message) =>
    message &&
    ["user", "assistant"].includes(message.role) &&
    typeof message.content === "string" &&
    message.content.trim().length > 0 &&
    message.content.length <= maxMessageLength,
  );
  const totalLength = messages.reduce(
    (total, message) => total + (typeof message?.content === "string" ? message.content.length : 0),
    0,
  );

  if (!validMessages || totalLength > maxConversationLength || messages.at(-1)?.role !== "user") {
    return response.status(400).json({ error: "ข้อความไม่ถูกต้องหรือยาวเกินกำหนด" });
  }

  const latestQuestion = messages.at(-1).content.trim();
  const requestType = classifyRequest(latestQuestion);
  if (requestType === "greeting") {
    return response.json({ kind: "instant", reply: "สวัสดีครับ Mali พร้อมช่วยครับ วันนี้อยากค้นหาเรื่องอะไร?" });
  }

  const apiKey = process.env.TINYFISH_API_KEY?.trim();
  if (!apiKey) {
    return response.status(503).json({ error: "เพิ่ม TINYFISH_API_KEY ในไฟล์ .env แล้วเริ่มเซิร์ฟเวอร์ใหม่" });
  }

  if (requestType === "search") {
    try {
      const searchUrl = new URL(tinyFishSearchUrl);
      searchUrl.searchParams.set("query", latestQuestion);
      searchUrl.searchParams.set("language", "th");
      searchUrl.searchParams.set("location", "TH");
      if (/ข่าว|เหตุการณ์|ประกาศ/.test(latestQuestion)) searchUrl.searchParams.set("domain_type", "news");

      const providerResponse = await fetch(searchUrl, { headers: { "X-API-Key": apiKey } });
      const result = await providerResponse.json();
      if (!providerResponse.ok) {
        return response.status(providerResponse.status).json({ error: result.error?.message || "ค้นหาไม่สำเร็จ" });
      }

      const results = Array.isArray(result.results) ? result.results.slice(0, 5) : [];
      return response.json({
        kind: "search",
        reply: formatSearchResults(latestQuestion, results),
        citations: results.map(({ title, url }) => ({ title, url })),
      });
    } catch (error) {
      console.error("TinyFish Search failed:", error.name);
      return response.status(502).json({ error: "เชื่อมต่อ TinyFish Search ไม่สำเร็จ กรุณาลองใหม่" });
    }
  }

  const previousMessages = messages.slice(-7, -1).map(({ role, content }) => {
    const speaker = role === "user" ? "ผู้ใช้" : "Mali";
    return `${speaker}: ${content.trim().slice(0, 600)}`;
  });
  const query = [
    "ค้นคว้าคำถามล่าสุดโดยใช้ข้อมูลจากเว็บที่น่าเชื่อถือ แล้วตอบเป็นภาษาไทยอย่างชัดเจน พร้อมอ้างอิงแหล่งข้อมูล",
    previousMessages.length ? `บริบทบทสนทนาก่อนหน้า:\n${previousMessages.join("\n")}` : "",
    `คำถามล่าสุด:\n${latestQuestion}`,
  ].filter(Boolean).join("\n\n");

  if (query.length > 10000) {
    return response.status(400).json({ error: "บทสนทนายาวเกินกำหนด กรุณาเริ่มแชตใหม่หรือย่อคำถาม" });
  }

  try {
    const providerResponse = await fetch(tinyFishResearchUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ query, mode: "deep", output_language: "th" }),
    });
    const result = await providerResponse.json();

    if (!providerResponse.ok) {
      const errorMessage = result.error?.message || "เริ่มค้นคว้าไม่สำเร็จ";
      return response.status(providerResponse.status).json({ error: errorMessage });
    }

    if (!result.research_run_id) {
      return response.status(502).json({ error: "TinyFish ไม่ได้ส่งรหัสงานกลับมา กรุณาลองใหม่" });
    }

    const runId = randomUUID();
    researchRuns.set(runId, { providerRunId: result.research_run_id, createdAt: Date.now() });
    return response.status(202).json({ kind: "research", runId, status: "QUEUED" });
  } catch (error) {
    console.error("TinyFish Research start failed:", error.name);
    return response.status(502).json({ error: "เชื่อมต่อ TinyFish ไม่สำเร็จ กรุณาตรวจการเชื่อมต่อแล้วลองใหม่" });
  }
});

app.get("/api/chat/:runId", async (request, response) => {
  const apiKey = process.env.TINYFISH_API_KEY?.trim();
  const run = researchRuns.get(request.params.runId);
  if (!apiKey) return response.status(503).json({ error: "เพิ่ม TINYFISH_API_KEY ในไฟล์ .env แล้วเริ่มเซิร์ฟเวอร์ใหม่" });
  if (!run) return response.status(404).json({ error: "ไม่พบงานค้นคว้านี้ อาจหมดอายุหรือเซิร์ฟเวอร์เริ่มใหม่แล้ว" });

  try {
    const providerResponse = await fetch(`${tinyFishRunsUrl}/${encodeURIComponent(run.providerRunId)}`, {
      headers: { "X-API-Key": apiKey },
    });
    const result = await providerResponse.json();
    if (!providerResponse.ok) {
      return response.status(providerResponse.status).json({ error: result.error?.message || "ตรวจสถานะงานไม่สำเร็จ" });
    }

    if (result.status === "COMPLETED") {
      const report = result.deep_result?.result;
      if (!report) return response.status(502).json({ error: "งานค้นคว้าเสร็จแล้วแต่ไม่มีรายงานกลับมา" });
      return response.json({
        status: result.status,
        reply: report,
        citations: result.deep_result.citations || [],
      });
    }

    if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(result.status)) {
      return response.json({ status: result.status, error: result.error?.message || "งานค้นคว้าไม่สำเร็จ กรุณาลองใหม่" });
    }

    return response.json({ status: result.status || "RUNNING" });
  } catch (error) {
    console.error("TinyFish Research status failed:", error.name);
    return response.status(502).json({ error: "ตรวจสถานะงานค้นคว้าไม่สำเร็จ กรุณาลองใหม่" });
  }
});

app.post("/api/chat/:runId/cancel", async (request, response) => {
  const apiKey = process.env.TINYFISH_API_KEY?.trim();
  const run = researchRuns.get(request.params.runId);
  if (!apiKey) return response.status(503).json({ error: "เพิ่ม TINYFISH_API_KEY ในไฟล์ .env แล้วเริ่มเซิร์ฟเวอร์ใหม่" });
  if (!run) return response.status(404).json({ error: "ไม่พบงานค้นคว้านี้" });

  try {
    const providerResponse = await fetch(`${tinyFishRunsUrl}/${encodeURIComponent(run.providerRunId)}/cancel`, {
      method: "POST",
      headers: { "X-API-Key": apiKey },
    });
    const result = await providerResponse.json();
    if (!providerResponse.ok) {
      return response.status(providerResponse.status).json({ error: result.error?.message || "ยกเลิกงานค้นคว้าไม่สำเร็จ" });
    }
    researchRuns.delete(request.params.runId);
    return response.json({ status: result.status, cancelled: result.cancelled });
  } catch (error) {
    console.error("TinyFish Research cancellation failed:", error.name);
    return response.status(502).json({ error: "ยกเลิกงานค้นคว้าไม่สำเร็จ" });
  }
});

setInterval(() => {
  const expiredBefore = Date.now() - 60 * 60 * 1000;
  for (const [runId, run] of researchRuns) {
    if (run.createdAt < expiredBefore) researchRuns.delete(runId);
  }
}, 10 * 60 * 1000).unref();

app.listen(port, "127.0.0.1", () => {
  console.log(`Mali is running at http://localhost:${port}`);
});