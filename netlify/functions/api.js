const express = require('express');
const cors = require('cors');
const serverless = require('serverless-http');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---------- 初始化 Redis ----------
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ---------- 辅助函数（与之前相同）----------
async function getUserCredits(userId) {
  const credits = await redis.get(`credits:${userId}`);
  if (credits === null) {
    await redis.set(`credits:${userId}`, 10);
    return 10;
  }
  return parseInt(credits);
}

async function setUserCredits(userId, credits) {
  await redis.set(`credits:${userId}`, credits);
}

async function decrementUserCredits(userId) {
  const credits = await getUserCredits(userId);
  if (credits <= 0) return false;
  await redis.decr(`credits:${userId}`);
  return true;
}

// ---------- DeepSeek API ----------
async function callDeepSeek(messages, maxTokens = 800) {
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: messages,
      temperature: 0.6,
      max_tokens: maxTokens
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`DeepSeek API 错误 ${response.status}: ${errText}`);
  }
  const data = await response.json();
  return data.choices[0].message.content;
}

// ---------- 路由定义 ----------
app.get('/api/credits', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: '缺少 userId' });
  const credits = await getUserCredits(userId);
  res.json({ credits });
});

app.post('/api/add-credits', async (req, res) => {
  const { userId, amount, adminSecret } = req.body;
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: '无效的管理员密钥' });
  }
  if (!userId || typeof amount !== 'number') {
    return res.status(400).json({ error: '参数错误' });
  }
  const current = await getUserCredits(userId);
  const newCredits = current + amount;
  await setUserCredits(userId, newCredits);
  console.log(`用户 ${userId} 增加 ${amount} 次，当前剩余 ${newCredits}`);
  res.json({ success: true, newCredits });
});

app.post('/api/generate', async (req, res) => {
  const { userId, prompt, style, wordCount } = req.body;
  if (!userId || !prompt) return res.status(400).json({ error: '缺少参数' });
  const credits = await getUserCredits(userId);
  if (credits <= 0) {
    return res.status(402).json({ error: '次数不足，请联系管理员充值' });
  }
  try {
    let systemContent = '你是语文教育专家，请撰写家长反馈。';
    if (style === 'formal') systemContent += ' 风格正式专业。';
    else if (style === 'friendly') systemContent += ' 风格温和亲切。';
    else if (style === 'brief') systemContent += ' 风格简洁有力。';
    else if (style === 'literary') systemContent += ' 风格文艺得体。';
    systemContent += ' 禁止使用Markdown格式，纯文本输出。';
    const messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: prompt }
    ];
    const maxTokens = Math.min(wordCount + 300, 2000);
    const content = await callDeepSeek(messages, maxTokens);
    await decrementUserCredits(userId);
    const remaining = await getUserCredits(userId);
    res.json({ success: true, content, remaining });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `生成失败: ${err.message}` });
  }
});

app.post('/api/analyze', async (req, res) => {
  const { userId, ocrText, provideAnswer, answerText } = req.body;
  if (!userId || !ocrText) return res.status(400).json({ error: '缺少参数' });
  const credits = await getUserCredits(userId);
  if (credits <= 0) {
    return res.status(402).json({ error: '次数不足，请联系管理员充值' });
  }
  let prompt = `你是一位语文作业批改专家。请根据以下作业内容进行逐题批改，分析每道题的对错，给出理由和建议。`;
  if (provideAnswer && answerText) {
    prompt += ` 参考答案如下：${answerText}`;
  } else {
    prompt += ` 未提供参考答案，请自主判断题目对错并给出合理解析。`;
  }
  prompt += ` 作业文本：${ocrText}。请以清晰段落输出批改结果。`;
  try {
    const messages = [
      { role: 'system', content: '你严格批改语文作业，指出对错并解释。输出纯文本。' },
      { role: 'user', content: prompt }
    ];
    const analysis = await callDeepSeek(messages, 1200);
    await decrementUserCredits(userId);
    const remaining = await getUserCredits(userId);
    res.json({ success: true, analysis, remaining });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `批改失败: ${err.message}` });
  }
});

app.get('/admin', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>充值管理</title><meta charset="UTF-8"></head>
    <body>
      <h2>管理员充值</h2>
      <p>请输入用户ID和增加次数</p>
      <input id="userId" placeholder="用户ID" />
      <input id="amount" placeholder="增加次数" type="number" />
      <button onclick="add()">增加</button>
      <div id="result"></div>
      <script>
        async function add(){
          const userId = document.getElementById('userId').value;
          const amount = parseInt(document.getElementById('amount').value);
          const adminSecret = prompt('管理员密钥');
          const res = await fetch('/api/add-credits', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ userId, amount, adminSecret })
          });
          const data = await res.json();
          if(data.success){
            alert('成功，剩余次数：'+data.newCredits);
            location.reload();
          } else {
            alert('失败：'+data.error);
          }
        }
      </script>
    </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.send('Backend is running on Netlify with Redis storage.');
});

// ---------- 导出 handler ----------
exports.handler = serverless(app);