# Receipt Ledger — 獨立網站版

拍日本收據 → AI 讀取 → 自動產生複式簿記仕訳、科目別集計、インボイス區分，可匯出 CSV。
支援青色／白色申告，介面可切換 English／日本語／中文。

**完全免費就能使用。** 讀收據有兩種模式，網站會自動選擇：

| 模式 | 條件 | 費用 | 準確度 |
|---|---|---|---|
| **免費模式**（預設） | 沒有設定 `ANTHROPIC_API_KEY` | 免費。在你的手機或電腦上用 Tesseract OCR 辨識，第一次會下載約 15 MB 日文資料 | 日期、合計、登録番号大多讀得到；10%／8% 拆分和科目需要多核對 |
| **Claude 模式** | 在 Vercel 設定 `ANTHROPIC_API_KEY` | 每張約 US$0.01（約 ¥1.5） | 高，連品項摘要、科目都會判斷 |

其他服務都用免費方案：

| 服務 | 用途 | 費用 |
|---|---|---|
| **Vercel** | 放網站 | Hobby 方案免費 |
| **Supabase** | 登入、資料庫、收據照片 | Free 方案免費（照片空間 1 GB，約 3,000 張收據） |

---

## 部署步驟（約 20 分鐘）

### 1. Supabase：建立資料庫
1. 到 <https://supabase.com> 註冊，按 **New project**。Region 選 **Northeast Asia (Tokyo)**，設定資料庫密碼。
2. 專案建好後，左側選 **SQL Editor → New query**，把 `supabase/schema.sql` 全部貼上，按 **Run**。
   這會建立帳冊、設定、修改紀錄三張表，以及私人的 `receipts` 照片空間，並設定「每個人只能看到自己的資料」。
3. 左側 **Project Settings → API**，記下：
   - **Project URL**（例如 `https://abcd1234.supabase.co`）
   - **anon public** key

### 2.（可省略）Anthropic：取得 API 金鑰
只想用免費模式就跳過這一步，之後隨時可以補上。

1. 到 <https://console.anthropic.com> 註冊並儲值（最少 US$5 就能用很久）。
2. **API Keys → Create Key**，複製金鑰（`sk-ant-...`），只會顯示一次。
3. 建議在 **Limits** 設定每月上限，例如 US$10，避免意外。

### 3. GitHub：上傳程式碼
1. 到 <https://github.com/new> 建立一個 **Private** repository，例如 `receipt-ledger`。
2. 在 repository 頁面按 **uploading an existing file**，把這個資料夾裡**所有檔案和資料夾**拖進去（`api/`、`supabase/`、`index.html` 等），按 **Commit changes**。

### 4. Vercel：發布網站
1. 到 <https://vercel.com> 用 GitHub 帳號登入，按 **Add New → Project**，選剛才的 repository，按 **Import**。
2. 展開 **Environment Variables**，加入：

   | Name | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | （可省略）第 2 步的金鑰。不填就是免費模式 |
   | `SUPABASE_URL` | 第 1 步的 Project URL |
   | `SUPABASE_ANON_KEY` | 第 1 步的 anon public key |
   | `ALLOWED_EMAILS` | 你自己的 email（多人用逗號分隔）。Claude 模式下只有這些人能使用 AI 辨識 |
   | `ANTHROPIC_MODEL` | （可省略）想省錢可填 `claude-haiku-4-5-20251001`，約便宜一半 |

3. 按 **Deploy**。完成後會得到網址，例如 `https://receipt-ledger.vercel.app`。

### 5. 回到 Supabase 完成登入設定
1. **Authentication → URL Configuration**：**Site URL** 填入 Vercel 的網址。
2. 打開你的網站，按「建立帳號」，用 email＋密碼註冊，到信箱點確認連結後登入。
3. 註冊完自己的帳號後，到 **Authentication → Sign In / Providers → Email**，關掉 **Allow new users to sign up**，陌生人就無法註冊。

### 6. 加到手機主畫面
- iPhone：用 Safari 打開網址 → 分享 → **加入主畫面**
- Android：用 Chrome 打開 → 選單 → **安裝應用程式**／**加到主畫面**

之後就像 App 一樣，點開直接拍收據。

---

## 安全與保存設計

- **資料隔離**：資料庫的 Row Level Security 讓每個登入者只能讀寫自己的仕訳與照片。
- **API 金鑰不外洩**：Anthropic 金鑰只存在 Vercel 伺服器，瀏覽器看不到；未登入或不在 `ALLOWED_EMAILS` 裡的人呼叫 AI 會被拒絕。
- **電子帳簿保存法**：
  - 收據照片存在私人空間，App 內**無法修改或刪除**照片。
  - 每次修改或刪除仕訳，舊內容會自動寫入 `entry_history`（訂正・削除の履歴），使用者無法竄改。
  - 可依取引日、金額、取引先檢索（仕訳帳的篩選）。
- **備份**：Supabase Free 方案沒有自動備份。建議每月在「仕訳帳」匯出一次 CSV 保存；需要時可升級 Pro 方案取得每日備份。

## 檔案說明

```
index.html            網站本體（介面、記帳邏輯、三語翻譯）
ocr.js                免費模式：裝置上的 OCR（自動判斷日文／英文／中文）與收據解析規則
api/scan.js           伺服器：驗證登入後，把收據照片送給 Claude 讀取
api/config.js         伺服器：提供瀏覽器公開的 Supabase 設定
supabase/schema.sql   資料表、修改紀錄、權限、照片空間
manifest.webmanifest  加到主畫面用的 App 設定
icon-*.png, icon.svg  App 圖示
vercel.json           伺服器設定（AI 辨識最長 60 秒）
```

## 常見問題

- **免費模式讀錯金額**：收據盡量拍平、光線充足、只拍收據本身。辨識後可直接在表單修改，按「確認入帳」前都不會記帳。
- **海外收據（美元、台幣等）**：會自動判斷語言和幣別。外幣金額會放在備註，請換算成日圓後填入「不課税・非課税」欄（國外交易不適用日本消費稅）。
- **想從免費模式升級**：在 Vercel 加上 `ANTHROPIC_API_KEY`，到 **Deployments** 按 **Redeploy** 即可，帳冊資料不受影響。
- **畫面顯示「網站尚未設定完成」**：Vercel 的 `SUPABASE_URL`／`SUPABASE_ANON_KEY` 沒設定或拼錯。修改後到 Vercel 的 **Deployments** 按 **Redeploy**。
- **AI 辨識顯示「這個帳號不能使用 AI 辨識」**：把你的 email 加進 `ALLOWED_EMAILS`，再 Redeploy。
- **AI 辨識顯示 Anthropic API 401／400**：API 金鑰錯誤或帳戶餘額不足。
- **Vercel Hobby 方案的使用條款**：Hobby 僅限非商業用途。記自己的帳通常沒問題，若有疑慮可升級 Pro（US$20／月）。

本工具協助整理帳冊，不代替稅理士判斷。申告前請再次確認科目與金額。
