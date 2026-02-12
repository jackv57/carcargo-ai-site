const https = require('https');

exports.handler = async function(event, context) {
  // 1. 只允許 POST 請求
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // 2. 從 Netlify 的環境變數讀取 Make.com 網址
  const makeUrl = process.env.MAKE_WEBHOOK_URL;

  if (!makeUrl) {
    return { statusCode: 500, body: "Server Error: Webhook URL not set." };
  }

  // 3. 準備將表單資料轉傳給 Make
  const formData = event.body;

  return new Promise((resolve, reject) => {
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formData)
      }
    };

    const req = https.request(makeUrl, options, (res) => {
      // 只要 Make 回傳 2xx 都算成功
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve({
          statusCode: 200,
          body: "Success"
        });
      } else {
        resolve({
          statusCode: res.statusCode,
          body: "Error connecting to Make"
        });
      }
    });

    req.on('error', (e) => {
      resolve({ statusCode: 500, body: "Internal Server Error" });
    });

    // 送出資料
    req.write(formData);
    req.end();
  });
};
