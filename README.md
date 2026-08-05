# J-OSLER 症例登録数管理アプリ（Googleログイン・クラウド同期版）

元ファイル「Josler症例登録・病歴要約チェックリスト120症例用20250504改訂版」をもとに、13分野・70疾患群・702項目を収録したWebアプリです。

## 保存方式

- 変更直後：端末内のIndexedDBとlocalStorageへ保存
- Googleログイン中：Cloud Firestoreへ自動同期
- オフライン時：端末内で継続使用し、オンライン復帰後に同期
- 競合時：端末版、クラウド版、自動統合から選択
- 同一端末で別Googleアカウントへ誤送信しないよう、端末とアカウントを紐付け

## 色の仕様

- 白：未入力
- 黄：症例ID入力済み（修了要件の症例数には未加算）
- 緑：症例登録完了
- 青：病歴要約完了（症例登録完了にも加算）

# 初回設定

## 1．Firebaseプロジェクトを作成

1. https://console.firebase.google.com/ を開きます。
2. 「プロジェクトを追加」を選択します。
3. 任意のプロジェクト名を設定します。例：`josler-case-manager`
4. Google Analyticsは、このアプリでは不要なので無効でも構いません。

## 2．Webアプリを登録

1. Firebaseのプロジェクト概要でWebアイコン `</>` を選択します。
2. アプリのニックネームを入力します。例：`JOSLER Web App`
3. Firebase Hostingは設定しなくて構いません。
4. 表示された `firebaseConfig` をコピーします。
5. このフォルダの `firebase-config.js` を開き、プレースホルダー部分を実際の値へ置き換えます。

例：

```javascript
window.JOSLER_FIREBASE_CONFIG = {
  apiKey: "実際の値",
  authDomain: "プロジェクトID.firebaseapp.com",
  projectId: "実際のプロジェクトID",
  storageBucket: "プロジェクトID.firebasestorage.app",
  messagingSenderId: "実際の値",
  appId: "実際の値"
};
```

FirebaseのWeb設定値はクライアントアプリへ含める前提の識別情報です。データ保護は、次項のFirestoreセキュリティルールで行います。

## 3．Googleログインを有効化

1. Firebaseコンソールで「Authentication」を開きます。
2. 「始める」を押します。
3. 「Sign-in method」から「Google」を選択します。
4. 「有効にする」をオンにします。
5. サポートメールを選び、保存します。
6. Authenticationの「設定」または「Settings」から「承認済みドメイン」を開きます。
7. GitHub Pagesのドメインを追加します。

例：GitHubユーザー名が `sample-user` の場合

```text
sample-user.github.io
```

リポジトリ名は含めません。

## 4．Cloud Firestoreを作成

1. Firebaseコンソールで「Firestore Database」を開きます。
2. 「データベースを作成」を押します。
3. Standard edition／Native modeを選択します。
4. 本番環境モードを選びます。
5. 保存場所を選択します。日本国内を希望する場合は `asia-northeast1（東京）` が選択肢です。

データベースのロケーションは後から容易に変更できないため、病院・組織の規程を確認してから選択してください。

## 5．Firestoreセキュリティルールを設定

1. このフォルダの `firestore.rules` を開きます。
2. 次の部分を、実際にログインするGoogleメールアドレスへ置き換えます。

```text
REPLACE_WITH_YOUR_GOOGLE_EMAIL
```

3. Firebaseコンソールの「Firestore Database」→「ルール」を開きます。
4. `firestore.rules` の内容をすべて貼り付けます。
5. 「公開」を押します。

このルールでは、指定したGoogleアカウント本人だけが、自分のUID配下の1文書を読み書きできます。それ以外のアクセスは拒否されます。

## 6．GitHubへアップロード

既存のGitHubリポジトリを開き、以下のファイルをリポジトリ直下へアップロードして、旧ファイルを上書きします。

```text
index.html
styles.css
catalog.js
app.js
firebase-config.js
cloud-sync.js
service-worker.js
manifest.webmanifest
icon.svg
.nojekyll
README.md
firestore.rules
```

GitHub Pagesで公開する対象は従来どおり `main` ブランチの `/(root)` です。

## 7．初回ログインと移行

1. GitHub Pagesのアプリを開きます。
2. 以前の端末内データが残っている場合、そのまま表示されます。
3. 「Googleでログイン」を押します。
4. Firestoreにデータがない場合、端末内の既存データが初回アップロードされます。
5. 別端末では、同じGoogleアカウントでログインするとクラウドデータが読み込まれます。

# 同期競合について

端末Aと端末Bをオフラインで別々に編集した後に同期すると、競合画面が表示されます。

- 自動統合：症例レコードごとに更新日時が新しいものを採用
- この端末を優先：クラウドを現在の端末内容で上書き
- クラウドを優先：現在の端末内容をクラウド内容で置換

置換や統合の前には、端末内に安全スナップショットを作成します。

# 重要な安全上の注意

- Cloud Firestore上のデータは、Firebase AuthenticationとFirestore Rulesでアクセス制限されますが、利用者だけが復号鍵を持つ「エンドツーエンド暗号化」ではありません。
- 症例IDは個人情報または個人関連情報として扱われる可能性があります。患者氏名、生年月日、住所、自由記載の詳細な病歴は入力しないでください。
- 個人のGoogleアカウント・個人契約のクラウド利用が勤務先の規程で許可されているとは限りません。実運用前に、所属施設の情報セキュリティ・個人情報保護方針を確認してください。
- 推奨は、組織管理下のGoogle Workspace／Google Cloudプロジェクトと、患者を直接特定できないJ-OSLER用管理番号の使用です。
- クラウド同期後も、定期的な暗号化バックアップを継続してください。

# 主なファイル

- `index.html`：画面構造
- `styles.css`：デザイン
- `catalog.js`：疾患カタログ
- `app.js`：入力・集計・端末保存・バックアップ処理
- `firebase-config.js`：利用者のFirebaseプロジェクト設定
- `cloud-sync.js`：Google認証・Firestore同期・競合処理
- `firestore.rules`：単一Googleアカウント用アクセス制御ルール
- `service-worker.js`：オフラインキャッシュ
