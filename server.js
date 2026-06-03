require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const userCredits = {};

function ensureUser(userId) {
  if (!userCredits[userId]) userCredits[userId] = 10;
  return userCredits[userId];
}

async function callDeepSeek(messages, maxTokens = 800) {
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0.6, max_tokens: maxTokens })
  });
  if (!response.ok) throw new Error(`DeepSeek API错误: ${response.status}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

app.get('/api/credits', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: '缺少userId' });
  res.json({ credits: userCredits[userId] ?? 10 });
});

app.post('/api/add-credits', (req, res) => {
  const { userId, amount, adminSecret } = req.body;
  if (adminSecret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: '无效的管理员密钥' });
  if (!userId || typeof amount !== 'number') return res.status(400).json({ error: '参数错误' });
  if (!userCredits[userId]) userCredits[userId] = 0;
  userCredits[userId] += amount;
  res.json({ success: true, newCredits: userCredits[userId] });
});

app.post('/api/generate', async (req, res) => {
  const { userId, prompt, style, wordCount } = req.body;
  if (!userId || !prompt) return res.status(400).json({ error: '缺少参数' });
  ensureUser(userId);
  if (userCredits[userId] <= 0) return res.status(402).json({ error: '次数不足' });
  try {
    let systemContent = '你是语文教育专家，请撰写家长反馈。';
    if (style === 'formal') systemContent += ' 风格正式专业。';
    else if (style === 'friendly') systemContent += ' 风格温和亲切。';
    else if (style === 'brief') systemContent += ' 风格简洁有力。';
    else if (style === 'literary') systemContent += ' 风格文艺得体。';
    systemContent += ' 禁止使用Markdown格式，纯文本输出。';
    const content = await callDeepSeek([{ role: 'system', content: systemContent }, { role: 'user', content: prompt }], Math.min(wordCount + 300, 2000));
    userCredits[userId]--;
    res.json({ success: true, content, remaining: userCredits[userId] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/analyze', async (req, res) => {
  const { userId, ocrText, provideAnswer, answerText } = req.body;
  if (!userId || !ocrText) return res.status(400).json({ error: '缺少参数' });
  ensureUser(userId);
  if (userCredits[userId] <= 0) return res.status(402).json({ error: '次数不足' });
  let prompt = `你是一位语文作业批改专家。请根据以下作业内容进行逐题批改，分析每道题的对错，给出理由和建议。${provideAnswer && answerText ? `参考答案如下：${answerText}` : '未提供参考答案，请自主判断题目对错并给出合理解析。'}作业文本：${ocrText}。请以清晰段落输出批改结果。`;
  try {
    const analysis = await callDeepSeek([{ role: 'system', content: '你严格批改语文作业，指出对错并解释。输出纯文本。' }, { role: 'user', content: prompt }], 1200);
    userCredits[userId]--;
    res.json({ success: true, analysis, remaining: userCredits[userId] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>充值管理</title></head><body><h2>管理员充值</h2><pre>${JSON.stringify(userCredits, null, 2)}</pre><input id="userId" placeholder="用户ID" /><input id="amount" placeholder="增加次数" type="number" /><button onclick="add()">增加</button><script>async function add(){const userId=document.getElementById('userId').value;const amount=parseInt(document.getElementById('amount').value);const adminSecret=prompt('管理员密钥');const res=await fetch('/api/add-credits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,amount,adminSecret})});const data=await res.json();alert(data.success?'成功，剩余次数：'+data.newCredits:'失败：'+data.error);location.reload();}</script></body></html>`);
});

const PORT = 3000;
app.listen(PORT, () => console.log(`后端运行在 http://localhost:${PORT}`));