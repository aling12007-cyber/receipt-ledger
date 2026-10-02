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
books.js              目前的記帳核心（一筆收據＝一列，仕訳即時推算），介面與測試共用
filing.js             申報準備：損益計算書、減価償却、貸借対照表的計算
engine/migrate.js     會計資料升級：舊資料 → 複式簿記仕訳（含稅區分），並核對餘額一致
imports.js            PDF（pdf.js）、HEIC 轉檔、Google Drive 匯入
pdfjs/                pdf.js 的日文字型對照檔（cmaps、standard_fonts，Apache-2.0）
ocr.js                免費模式：裝置上的 OCR（自動判斷日文／英文／中文）與收據解析規則
api/scan.js           伺服器：驗證登入後，把收據照片送給 Claude 讀取
api/config.js         伺服器：提供瀏覽器公開的 Supabase 設定
supabase/schema.sql   資料表、修改紀錄、權限、照片空間
supabase/002_accounting_core.sql  會計核心：科目表、證憑、取引、仕訳／仕訳行、年度、固定資產、稽核紀錄
tests/                Golden Test Cases 與自動測試（npm test）
supabase/tests/       資料庫規則測試（本機 Postgres）
manifest.webmanifest  加到主畫面用的 App 設定
icon-*.png, icon.svg  App 圖示
vercel.json           伺服器設定（AI 辨識最長 60 秒）
```

## 複式簿記帳簿

每張收據都存成正式仕訳（借方、貸方、稅區分、稅額）。借貸不平衡的仕訳不能確定；修改是「先沖銷、再記入正確的」；鎖定的年度不能寫入。
刪除是永久的：資料、它的仕訳（包含先前的沖銷與更正）、修改紀錄和收據影像會一起刪除，不計入仕訳帳、試算表或任何計算。

1. Supabase → **SQL Editor** → **New query**，貼上 `supabase/002_accounting_core.sql` 全部內容 → **Run**（重複執行也安全，不會動到現有資料）。
2. 網站 → **設定** → 確認「消費稅身分」正確 → **與複式簿記帳簿同步** →「同步並核對」。
3. 畫面顯示「核對通過」代表新帳簿每個科目的餘額都和目前資料一致。之後每次儲存或刪除都會自動同步。

SQL 檔案更新時，畫面會提示「會計核心是舊版本」，在 SQL Editor 重新執行一次即可。

注意：永久刪除不保留訂正・刪除履歷，因此不符合「優良な電子帳簿」與收據掃描保存（スキャナ保存）的要件。青色申告 65 萬円控除用 e-Tax 申報即可取得；建議保留紙本收據或原始檔。

## （可選）Google Drive 匯入

設定後，「拍收據」頁會出現 **Google Drive** 按鈕，可一次勾選多張 JPG／PNG／HEIC／PDF 收據。網站只用 `drive.file` 權限，**只能讀取你勾選的檔案**，看不到 Drive 其他內容。帳上還有的檔案會自動略過；資料刪除後可以重新匯入。

1. 打開 <https://console.cloud.google.com/>，上方專案選單 → **新增專案**，名稱 `receipt-ledger` → 建立。
2. 左側 **API 和服務 → 程式庫**，分別搜尋並 **啟用**：`Google Drive API`、`Google Picker API`。
3. 左側 **Google Auth Platform**（或「OAuth 同意畫面」）→ 開始設定：應用程式名稱 `Receipt Ledger`、支援 email 填你的 Gmail、目標對象選 **外部**，並在「測試使用者」加入你自己的 Gmail。
4. **用戶端（Clients）→ 建立用戶端** → 類型 **網頁應用程式** →「已授權的 JavaScript 來源」加入 `https://receipt-ledger-pi.vercel.app`，「已授權的重新導向 URI」加入 `https://receipt-ledger-pi.vercel.app/`（結尾要有斜線）→ 建立，複製 **用戶端 ID**。
5. **API 和服務 → 憑證 → 建立憑證 → API 金鑰** → 編輯：應用程式限制選 **HTTP 參照網址** `https://receipt-ledger-pi.vercel.app/*`，API 限制只勾 **Google Picker API**，複製 **API 金鑰**。
6. 資訊主頁的「專案資訊」裡複製 **專案編號**（一串數字）。
7. Vercel 新增環境變數 `GOOGLE_CLIENT_ID`、`GOOGLE_API_KEY`、`GOOGLE_APP_ID`（=專案編號），然後 Redeploy。

應用程式維持「測試中」即可（只有你自己用）；測試模式下 Google 每 7 天會要求重新同意一次，屬正常現象。

## PDF 與 HEIC

- **PDF**：電子收據 PDF 大多內含文字，會直接讀取，不經 OCR，最準確。掃描型 PDF 則轉成圖片再辨識。PDF 原檔原樣保存（電子帳簿保存法「電子取引データ」需保存原始電子檔）。
- **HEIC**：iPhone 的 HEIC 照片在 Chrome 等瀏覽器會自動轉成 JPG。

## 報稅（申報準備分頁）

「申報準備」分頁依照青色申告決算書（一般用）的 4 頁整理好所有數字：
1. **損益計算書**：依決算書欄位編號（①〜㊺）列出，空欄行會自動放入会議費等非標準科目。
2. **月別売上・仕入、地代家賃の内訳**。
3. **減価償却**：登錄 10 萬円以上的資產，自動計算定額法／一括償却／少額特例（2026/4 起未滿 40 萬円）。
4. **貸借対照表**：輸入期初、期末餘額，帳外出入金自動以事業主貸／事業主借調整。

接著到國稅廳「確定申告書等作成コーナー」照欄位轉記，用 e-Tax 送出。

## 常見問題

- **免費模式讀錯金額**：收據盡量拍平、光線充足、只拍收據本身。辨識後可直接在表單修改，按「確認入帳」前都不會記帳。
- **海外收據（美元、台幣等）**：會自動判斷語言和幣別。外幣金額會放在備註，請換算成日圓後填入「不課税・非課税」欄（國外交易不適用日本消費稅）。
- **想從免費模式升級**：在 Vercel 加上 `ANTHROPIC_API_KEY`，到 **Deployments** 按 **Redeploy** 即可，帳冊資料不受影響。
- **畫面顯示「網站尚未設定完成」**：Vercel 的 `SUPABASE_URL`／`SUPABASE_ANON_KEY` 沒設定或拼錯。修改後到 Vercel 的 **Deployments** 按 **Redeploy**。
- **AI 辨識顯示「這個帳號不能使用 AI 辨識」**：把你的 email 加進 `ALLOWED_EMAILS`，再 Redeploy。
- **AI 辨識顯示 Anthropic API 401／400**：API 金鑰錯誤或帳戶餘額不足。
- **Vercel Hobby 方案的使用條款**：Hobby 僅限非商業用途。記自己的帳通常沒問題，若有疑慮可升級 Pro（US$20／月）。

本工具協助整理帳冊，不代替稅理士判斷。申告前請再次確認科目與金額。
