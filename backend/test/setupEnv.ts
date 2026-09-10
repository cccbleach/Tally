// 测试环境统一隔离：作为 node:test 的 --import 预加载模块，在所有测试文件之前执行。
//
// 为什么需要：src/config.ts 在导入时会自动加载 backend/.env（本机开发环境里可能含
// **真实阿里云短信凭据**且 ALIYUN_SMS_ENABLED=true）。虽然现有测试文件都在顶部显式关闭了短信，
// 但那是"每个文件各自记得写"的约定——新增测试文件若忘记，就会真的调用阿里云外呼（费用 + 短信轰炸）。
// 这里在进程启动阶段统一关掉短信并清空凭据，使默认路径永远安全。
process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";
process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = "";
process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = "";
