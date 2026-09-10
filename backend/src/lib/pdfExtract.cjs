// PDF 文本抽取脚本（独立子进程，非 worker 线程）。
//
// 为什么用 child_process 而不是 worker_threads：
//   1) pdf-parse 内部经 ESM 加载 pdf.js；worker 线程与主进程共享文件描述符表，
//      worker 内的 ESM loader 会把 fd 标记成 "unmanaged mode"，批量打印
//      “File descriptor ... opened/closed in unmanaged mode” 告警（本仓库把 FD 告警 = 0
//      作为验收标准）。独立进程有各自的 fd 表，不存在该问题。
//   2) 进程级隔离才是真正的硬隔离：解析崩溃/OOM 不会拖垮服务进程（worker 仅共享地址空间
//      边界，见 xlsxWorker.cts 的说明）。
//
// 协议：stdin 传入 PDF 原始字节；stdout 输出单行 JSON {ok, text} 或 {ok:false, error}。
// 资源上限由父进程施加：--max-old-space-size + 超时 SIGKILL + 并发槽位。
//
// 本文件是真正的 CommonJS（.cjs），与 pdfExtract.cts 的编译产物等价；
// 开发/测试环境直接运行本文件，生产运行 dist/lib/pdfExtract.cjs。
"use strict";

const PDF_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB（上传层另有 20MB 总量限制）
const PDF_MAX_TEXT_BYTES = 20 * 1024 * 1024; // 抽出文本上限，防止超大输出

async function main() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > PDF_MAX_FILE_SIZE) {
      throw new Error("PDF_TOO_LARGE: PDF 超过 10MB 上限");
    }
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  if (buf.length === 0) throw new Error("PDF_PARSE_FAILED: 空文件");

  const { PDFParse } = require("pdf-parse");
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
  .then((text) => {
    process.stdout.write(JSON.stringify({ ok: true, text }));
  })
  .catch((e) => {
    process.stdout.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  })
  .finally(() => {
    // 显式退出，避免 pdf.js 残留句柄让子进程悬挂（父进程另有超时兜底）
    process.exit(0);
  });
