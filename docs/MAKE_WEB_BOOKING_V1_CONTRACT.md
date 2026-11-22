# CAR CAR GO 網站收單 V1 串接規格

本文件供 Make 正式場景 **4066738** 實作與驗收使用。正式場景仍暫停。隔離場景 **7125309** 是 on-demand 子場景，已驗證輸入欄位、Data Store 防重、Sheets 寫入與輸出資料。正式 Webhook 須將子場景的整數 `code` 映射為實際 HTTP 狀態，並回傳同一份 JSON。正式與隔離場景各用自己的接收端、Data Store 和試算表。

## 請求

瀏覽器對同網域 `POST /.netlify/functions/submit`，使用 `Content-Type: application/json`，JSON 根節點為物件，請求上限為 16,384 UTF-8 bytes。瀏覽器送出預約欄位和 `request_id`；包車另外送出 `areas`。Function 驗證、正規化並自行計算 `request_fingerprint`，再以 HTTPS POST JSON 送到 Make。下例為 **Function → Make** 的虛構接機資料，指紋對應此範例內容。

```json
{
  "request_id": "b02f5770-057f-4d31-8b73-a2a3d2ece8e8",
  "request_fingerprint": "ebbbaa4c1299c07934a7f261e7f20024a93dafa740fb167beb366ddb288dd79b",
  "service_type": "pickup",
  "full_name": "Café Rider",
  "contact": "+886 912 345 678",
  "email": "mock@example.test",
  "whatsapp": "+1 202 555 0100",
  "contact_preference": "whatsapp",
  "flight": "ZZ123",
  "datetime": "2030-01-01T10:00",
  "pickup": "Mock Airport",
  "dropoff": "Mock Hotel",
  "passengers": "2",
  "luggage": "0",
  "notes": "A\nB"
}
```

| 欄位 | JSON 型別及驗證 |
| --- | --- |
| `request_id` | string，必填。小寫標準 UUID v4。 |
| `request_fingerprint` | string，Function 必須送出 64 個小寫十六進位字元，Make 保存並比較。瀏覽器提供的值會被忽略。 |
| `service_type` | string，必填。限 `dropoff`、`pickup`、`charter`。 |
| `full_name` | string，必填，去除前後空白後須有內容。 |
| `contact`、`whatsapp` | string。電話必填，WhatsApp 選填。首位可為 `+`，其後先有數字。可含空格、括號、句點及連字號，移除這些分隔符後須有 7–15 位 ASCII 數字。保留國碼和前導零。 |
| `email` | string，必填。Function 檢查 `^[^\s@]+@[^\s@]+\.[^\s@]+$`；隔離場景宣告為 Make 的 email 型別。 |
| `contact_preference` | string，網站必填。限 `line`、`whatsapp`、`email`、`phone`。即使偏好 WhatsApp，WhatsApp 欄位仍可省略。 |
| `flight`、`datetime`、`pickup`、`dropoff` | string，送機與接機必填，包車省略。`datetime` 由網頁的本地日期時間欄位提供，例如 `2030-01-01T10:00`，不含時區。Function 檢查非空，現場營運解讀為台灣時間。 |
| `charter_date`、`hours` | string，包車必填，送機與接機省略。網頁日期欄位送出 `YYYY-MM-DD`，時數選單送出 `"4"` 或 `"8"`。Function 檢查非空。 |
| `passengers`、`luggage` | string，選填。十進位數字字串，數值必須為安全整數，人數至少 1、行李至少 0。 |
| `notes` | string，選填。包車時必有規劃區域。Function 將 `areas` 整理為 `Planned areas: <areas>`，如果有備註則接上兩個 LF 與原備註。Make 契約不另收 `areas`。 |

空字串與不適用的行程欄位會被省略。隔離場景宣告了上述 17 個輸入及對應 Sheets 映射，`contact_preference` 和各服務的條件必填欄位在其介面為選填。正式場景應採用表中網站規則，並以 RAW 寫入 Sheets。Function 不會發起付款或派單。

## 送單識別與指紋

1. 瀏覽器透過 `crypto.randomUUID()` 產生 v4 UUID。送出前，把本機表單摘要和 UUID 存進 `sessionStorage`，不保存表單原文。同一分頁重新整理或重送相同內容時沿用同一 UUID。待處理、結果不明或衝突期間，頁面會阻擋用修改後的資料產生新請求。分頁關閉或儲存被清除後，若結果未明，應先由客服查詢。資料層仍需以 `request_id` 防重。
2. Function 對接受的預約字串，將 CRLF 與獨立 CR 轉為 LF、做 Unicode NFC、執行 ECMAScript `trim()`。省略空值，排除其他服務欄位，包車先將 `areas` 併入 `notes`。保留內部空白、電話分隔符、大小寫和字串數值的拼法。
3. 僅取真正送給 Make 的預約欄位，排除 `request_id` 和 `request_fingerprint`。依欄位名稱排序，用 WHATWG `URLSearchParams.sort()` 及 `.toString()` 序列化。鍵值由 `=` 分隔，各列由 `&` 分隔，空格編碼為 `+`，其餘依表單百分比編碼。
4. 對該序列化字串的 UTF-8 bytes 計算 SHA-256，輸出 64 位小寫十六進位。上方 JSON 的可重現向量如下。

```text
contact=%2B886+912+345+678&contact_preference=whatsapp&datetime=2030-01-01T10%3A00&dropoff=Mock+Hotel&email=mock%40example.test&flight=ZZ123&full_name=Caf%C3%A9+Rider&luggage=0&notes=A%0AB&passengers=2&pickup=Mock+Airport&service_type=pickup&whatsapp=%2B1+202+555+0100
SHA-256 ebbbaa4c1299c07934a7f261e7f20024a93dafa740fb167beb366ddb288dd79b
```

## HTTP 回執

使用 `Content-Type: application/json`，每種回應都要原樣回傳 `request_id`，整數 `code` 必須等於 HTTP 狀態。正式訂單編號由 Make 寫入 Sheets，格式為 `CCG-<request_id>`。隔離流程使用 `TCCG-<request_id>`，Function 和前端都驗證前綴與完整 UUID 是否相符。瀏覽器只顯示回執中的編號。

**201 首次寫入並確認**

```json
{"code":201,"status":"recorded","order_id":"CCG-b02f5770-057f-4d31-8b73-a2a3d2ece8e8","request_id":"b02f5770-057f-4d31-8b73-a2a3d2ece8e8"}
```

**200 已寫入的同鍵同指紋重送**

```json
{"code":200,"status":"recorded","order_id":"CCG-b02f5770-057f-4d31-8b73-a2a3d2ece8e8","request_id":"b02f5770-057f-4d31-8b73-a2a3d2ece8e8"}
```

**202 結果尚待確認**

```json
{"code":202,"status":"processing","order_id":"","request_id":"b02f5770-057f-4d31-8b73-a2a3d2ece8e8"}
```

**409 同鍵不同指紋**

```json
{"code":409,"status":"conflict","order_id":"","request_id":"b02f5770-057f-4d31-8b73-a2a3d2ece8e8"}
```

一般 HTTP 成功、純文字 Accepted、回執 JSON 無效、ID 不符或 Function 等待上游逾時，均為送單結果不明，網站保留原 ID。Function 等待 Make 最多 12 秒，瀏覽器等待 Function 最多 18 秒。不確定原請求結果時，只以原資料與同一 ID 重試。

## 正式 Make 模組與對帳

1. **Custom Webhook。** 核對場景 4066738 的接收端，設定 JSON 資料結構。補上欄位驗證與入口路由。
2. **Data Store 查詢及保留。** 以 `request_id` 為唯一鍵，初次保留以不可覆寫的新增建立 `PENDING` 紀錄，保存指紋與 Make 產生的訂單編號。若另一執行先取得保留，重新讀取紀錄並按相同鍵分支處理。指紋不一致直接回 409。已有 `RECORDED` 的相同請求回原編號。
3. **Google Sheets Add a Row。** 只有取得保留的首次執行可新增。使用 RAW，保存請求 ID、指紋及預留編號，同時寫入預約資料。成功後更新 Data Store 為 `RECORDED`，再由 Webhook Response 回 201。確認編號前不觸發付款、通知或派單。
4. **PENDING 對帳支線。** 若 Sheets 已寫入但 Data Store 尚未更新，或寫入結果不明，按完整 `request_id` 搜尋 Sheets。僅在找到唯一且指紋與預留編號皆相符的列時，補更新 `RECORDED`，並回 200 和該列編號。沒有找到列、找到多筆、欄位不符或查詢失敗時，維持 202 並交由人工查核，避免重複新增。若確實需要恢復寫入，先確認沒有原執行在途，再由唯一持有保留權的流程寫入。
5. **Webhook Response。** 每條路徑配置實際的 HTTP 狀態與前述 JSON。隔離場景的 Return Data 只回傳資料結構；正式 HTTP 入口需要此模組。完成前維持正式場景暫停。

## Netlify 與驗收安全

- `MAKE_WEBHOOK_URL` 是 Functions 端環境變數。Webhook URL、路徑中的 Token 和其他金鑰不放入前端、Git、錯誤訊息、測試或公開日誌。
- `MAKE_4066738_WEBHOOK_SHA256` 是已核對的正式接收端完整 URL（去除前後空白）的 SHA-256 小寫十六進位。只能從 Make 正式接收端設定獨立取得後，在私密環境計算並比對。勿從既有 Netlify URL 直接信任並建立指紋。任一值缺失或不符時，Function 停止轉送。Function 拒絕上游 HTTP 重新導向。
- 正式接收端、Production Functions 設定和官方客服聯繫資料須獨立確認。先用隔離 Webhook 和測試表做端到端驗收，涵蓋全部回執、並行重送及寫入後逾時的對帳恢復。本機測試使用合成資料及 Mock，不連線 Make 或 Sheets。可用 Node.js 24 執行 `node tests/web-booking-v1.mjs`。

### Deploy Preview 隔離驗收

Function 依 Netlify 傳入的執行階段 `context.deploy.context` 選擇接收端，只接受 `production` 和 `deploy-preview`。缺少情境、情境未知、接收端設定缺少或指紋不符時，合法表單請求會回 503。Function 不使用建置階段的 `CONTEXT` 環境變數，也不依請求網址或標頭推斷部署情境。[Netlify Functions API](https://docs.netlify.com/build/functions/api/#deploy)

| 變數 | Netlify 部署情境 | 用途 |
| --- | --- | --- |
| `MAKE_WEBHOOK_URL` | Production | 正式場景 4066738 的接收端，僅正式 Function 讀取，標記為機密。 |
| `MAKE_4066738_WEBHOOK_SHA256` | Production、Deploy Previews | 同一個獨立核對的正式 URL 指紋。正式用於驗證接收端，Preview 僅用於拒絕相同的接收端。 |
| `MAKE_PREVIEW_WEBHOOK_URL` | Deploy Previews | 隔離 Webhook 場景 7131948 的接收端，標記為機密。 |
| `MAKE_PREVIEW_WEBHOOK_SHA256` | Deploy Previews | 獨立核對 7131948 的 URL 後計算的 SHA-256。 |

上述變數的 scope 需涵蓋 Functions。正式 URL 必須移除 All deploy contexts 的值。摘要可供比較，完整 URL 和 Token 留在各自部署情境。Preview 必須能讀取 64 位小寫十六進位的正式摘要作為拒絕比對，缺少正式摘要也回 503。接收端使用 Make 提供的小寫 HTTPS 主機名及原樣路徑。部署使用建立時的變數設定，修改後須重新建立 Preview。[Netlify 環境變數](https://docs.netlify.com/build/functions/environment-variables/)

1. 先核對正式 URL 僅存在於 Production。之後如獲授權，可以在未提供 Preview 接收端的情況下做靜態頁與表單驗收，但先保留轉送鎖定。雲端端點的 503 驗收須等到另外允許發出驗收請求，並確認部署版本與 Preview 專用接收端確實未配置。
2. 測試 Google 連線 12476560 已完成權限隔離。啟用前，唯讀核對 7131948 與所有子場景的 Sheets 連線 ID、試算表 ID、權限及測試 Data Store。通知、付款及派單保持停用。
3. 在取得啟用測試場景及發送虛構訂單的授權前，暫停所有會觸發 Make 或 Sheets 的雲端驗收。取得授權後，依下方清單測試回執與防重。


## Deploy Preview 操作與驗收清單

以下部署操作須等到明確授權。建立 Preview 與啟用測試場景／發送虛構訂單分開授權。

### A. 獨立分支與部署

- [ ] 在 Netlify 記錄目前 Production 已發布的 Deploy ID 和 Git SHA。確認連接 `jackv57/carcargo-ai-site`、Production branch 為 `main`，且已啟用 GitHub PR 的 Deploy Previews。檢查測試分支是否同時觸發 branch deploy；驗收只使用 PR 的 Deploy Preview。
- [ ] 從目前工作區建立 `preview/booking-v1`。只加入下列五份檔案，檢查已暫存差異，再提交及推送這一條分支。以下指令須在授權後執行。

```bash
cd ~/Documents/carcargo-ai-site
git status --short --branch
git switch -c preview/booking-v1
git add -- .gitignore index.html netlify/functions/submit.mts docs/MAKE_WEB_BOOKING_V1_CONTRACT.md tests/web-booking-v1.mjs
git diff --cached --check
git diff --cached --stat
git diff --cached
# 確認差異、分支及機密檢查均通過後，再繼續。
git commit -m "Prepare CAR CAR GO booking V1 preview"
git push -u origin preview/booking-v1
```

- [ ] 在 GitHub 建立 Draft PR，base 為 `main`、head 為 `preview/booking-v1`。保持 PR 未合併，避免推送 `main`、切換正式發布分支、選擇 Publish deploy 或使用 `--prod`。
- [ ] 在 Netlify 等待該 PR 的 Deploy Preview 成功。比對 deploy context 為 `deploy-preview`、SHA 等於 PR head，並確認 Production 的已發布 Deploy ID 與 SHA 和基準一致。使用 Netlify 展示的 Preview URL，通常為 `deploy-preview-<PR 編號>--candid-sunflower-d591df.netlify.app`。[Netlify Deploy Previews](https://docs.netlify.com/deploy/deploy-types/deploy-previews/)

### B. Make 停用期間的 Preview 驗收

- [ ] 只在 Preview 網址確認四語切換、手機版、三種行程、必填欄位及 WhatsApp 同號。成功畫面及 `200/201/202/409/502/503` 錯誤情境用瀏覽器攔截 Function 請求並回傳本機 Mock，攔截須在表單送出前生效。
- [ ] 讀取 Deploy 記錄，確認 `submit` Function 已打包，正式 URL 沒有套用到 Preview，Preview URL 與指紋只套用 Deploy Previews，Preview 可讀取正式比對指紋。只記錄名稱、scope 和 context。
- [ ] 若已獲授權執行無副作用的端點探測，先把下方 `PREVIEW_ORIGIN` 設成該 PR 的實際 Preview origin。GET 必須回 `405 method_not_allowed`；空 JSON 必須回 `400 invalid_fields`。這兩條在讀取 Webhook 設定及轉送前就會結束。若先遇到存取保護，從已登入的 Preview 瀏覽器執行同等檢查。

```bash
PREVIEW_ORIGIN='https://deploy-preview-<PR 編號>--candid-sunflower-d591df.netlify.app'
curl -sS -i "${PREVIEW_ORIGIN}/.netlify/functions/submit"
curl -sS -i -H 'Content-Type: application/json' --data '{}' "${PREVIEW_ORIGIN}/.netlify/functions/submit"
```

- [ ] 在已配置接收端的 Preview 上，保持有效訂單 POST 及直接 Webhook 呼叫停用。Make 場景暫停時，上游可能回錯誤；以本機測試驗證 `503` 隔離分支，而非用有效表單探測已配置的接收端。

### C. 另行授權後的虛構訂單測試

- [ ] 先限制 Preview 的測試者存取，核對場景 `7131948`、Google 連線 `12476560`、測試試算表 ID 與測試 Data Store。檢查所有子場景，確認通知、付款及派單維持停用。只有隔離測試場景可在授權的測試時段啟用，正式 `4066738` 保持停用。
- [ ] 使用虛構姓名、電話、行程和 `example.test` 信箱，從 **Preview Function** 送出。第一筆預期 `201 recorded`，確認回執的 `request_id` 相符，畫面編號等於測試 Sheets 的 `order_id`。
- [ ] 原 UUID、原資料重送預期 `200 recorded`、原編號；使用相同 UUID 改一個欄位預期 `409 conflict`。同 UUID 並行請求後，Sheets 仍只有一列；其中一次可能在寫入尚未完成時回 202。
- [ ] 用隔離流程的受控測試分支模擬待處理、逾時或壞回執。預期 `202 processing` 或 `502 delivery_unknown`，畫面不顯示編號；重新整理後用原資料重試沿用原 UUID，對帳完成後回原編號，沒有新增列。
- [ ] 記錄 Preview SHA、測試 UUID、HTTP 狀態、測試表列數及對帳結果。停用測試場景，重查 Production Deploy ID 與 SHA 仍一致，保留 Draft PR 等待下一次授權。

### 正式收單啟用條件

更新版 Function 在 Production 預設回 503。只有個資告知及條款核定、人工流程完成演練並另行授權後，才可在 Production 的 Functions scope 設定 `BOOKING_PRODUCTION_ENABLED=true` 並重新部署。部署設定不應讓這項開關流入 Preview。正式 Make 場景的啟用另需授權。網站以 POST 傳送，異常畫面顯示可複製的原需求參考碼，客服連結本身不帶參考碼或旅客欄位。
