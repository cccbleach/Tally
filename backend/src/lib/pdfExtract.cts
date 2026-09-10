// PDF 文本抽取脚本的 TypeScript 源（编译为 dist/lib/pdfExtract.cjs），
// 与同目录 pdfExtract.cjs 保持等价：开发/测试直接运行 .cjs，生产运行编译产物。
//
// 用 child_process 而非 worker_threads 的原因见 pdfExtract.cjs 顶部说明：
// 进程级隔离更硬，且避免 worker 内 ESM 加载 pdf.js 触发的 FD "unmanaged mode" 告警。
//
// 协议：stdin 传入 PDF 原始字节；stdout 输出单行 JSON {ok, text} 或 {ok:false, error}。

const PDF_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const PDF_MAX_TEXT_BYTES = 20 * 1024 * 1024;

async function main(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const c = chunk as Buffer;
    total += c.length;
    if (total > PDF_MAX_FILE_SIZE) {
      throw new Error("PDF_TOO_LARGE: PDF 超过 10MB 上限");
    }
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks);
  if (buf.length === 0) throw new Error("PDF_PARSE_FAILED: 空文件");

  const { PDFParse } = require("pdf-parse") as {
    PDFParse: new (opt: { data: Uint8Array }) => {
      getText(): Promise<{ text: string }>;
      destroy(): Promise<void>;
    };
  };
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  let text = "";
  try {
    const result = await parser.getText();
    text = result.text ?? "";
  } finally {
    await parser.destroy();
  }
  if (Buffer.byteLength(text, "utf8") > PDF_MAX_TEXT_BYTES) {
    throw new Error("PDF_TOO_LARGE: PDF 文本内容过大");
  }
  return text;
}

main()
  .then((text: string) => {
    process.stdout.write(JSON.stringify({ ok: true, text }));
  })
  .catch((e: unknown) => {
    process.stdout.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  })
  .finally(() => {
    process.exit(0);
  });
