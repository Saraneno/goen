// ============================================================
// GOEN - LINE Webhook Server v2（Koyoi構成参考）
// LINEはリンク送信と通知専用。入力はすべてブラウザへ。
// ============================================================

require('dotenv').config();
const express = require('express');
const { middleware, Client } = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const lineClient = new Client(lineConfig);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BASE_URL = process.env.BASE_URL; // 例: https://goen.jp

// ── Webhook ───────────────────────────────────────────────
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events) {
    try { await handleEvent(event); } catch (e) { console.error(e); }
  }
});

// ── イベント振り分け ──────────────────────────────────────
async function handleEvent(event) {
  const userId = event.source.userId;
  if (event.type === 'follow')   return handleFollow(userId);
  if (event.type === 'postback') return handlePostback(event, userId);
  if (event.type === 'message' && event.message.type === 'text')
    return handleText(event, userId, event.message.text.trim());
}

// ① 友だち追加 → DB登録 → 登録ページへ誘導
async function handleFollow(userId) {
  const profile = await lineClient.getProfile(userId);

  await supabase.from('users').upsert(
    { line_user_id: userId, display_name: profile.displayName, registration_step: 1 },
    { onConflict: 'line_user_id', ignoreDuplicates: true }
  );

  await lineClient.pushMessage(userId, [
    {
      type: 'text',
      text: `🍻 GOENへようこそ、${profile.displayName}さん！\n\nその瞬間、その場で繋がるグループ飲みマッチングサービスです。\n\nまずはプロフィールを登録しましょう👇`,
    },
    registerButton(userId),
  ]);
}

// ③ テキスト受信
async function handleText(event, userId, text) {
  const user = await getUser(userId);

  if (text === '登録する' || text === '登録') {
    return reply(event, [registerButton(userId)]);
  }
  if (text === '飲みを探す' || text === '希望を出す') {
    if (!user || user.verify_status !== 'approved') {
      return reply(event, [
        { type: 'text', text: '⚠️ まず登録・審査を完了してください。' },
        registerButton(userId),
      ]);
    }
    return reply(event, [requestButton(userId)]);
  }
  if (text === 'マイページ' || text === '状況確認') {
    return reply(event, [mypageButton(userId)]);
  }

  // デフォルト：メインメニュー
  return reply(event, [mainMenu()]);
}

// ④ ポストバック
async function handlePostback(event, userId, data) {
  // 現状はpostbackはメニューからのみ → mainMenuに集約
  await reply(event, [mainMenu()]);
}

// ============================================================
// LINE通知API（server内から呼び出す用）
// ============================================================

// ⑤ 審査完了通知
async function notifyApproved(lineUserId) {
  await lineClient.pushMessage(lineUserId, [
    { type: 'text', text: '✅ 審査が完了しました！\n\nGOENへようこそ🎉\n\n今すぐ飲みの希望を出しましょう👇' },
    requestButton(lineUserId),
  ]);
}

// ⑤ 審査否認通知
async function notifyRejected(lineUserId, reason) {
  await lineClient.pushMessage(lineUserId, {
    type: 'text',
    text: `❌ 審査の結果、登録をお断りさせていただきました。\n\n理由: ${reason}\n\nご不明な点はお問い合わせください。`,
  });
}

// ⑧ マッチング成立通知
async function notifyMatched(lineUserId, match) {
  await lineClient.pushMessage(lineUserId, [
    {
      type: 'text',
      text: `🎉 マッチングが成立しました！\n\n📍 エリア: ${match.area}\n⏰ 時間: ${match.meet_time}\n\n${match.venue_name ? `🏮 提案店舗: ${match.venue_name}\n📌 ${match.venue_address}` : ''}`,
    },
    {
      type: 'template',
      altText: 'LINEグループへ',
      template: {
        type: 'buttons',
        text: 'LINEグループで詳細を確認してください',
        actions: [
          { type: 'uri', label: '💬 グループを開く', uri: `https://line.me/R/ti/g/${match.line_group_id}` },
          { type: 'uri', label: '🗺 店舗を見る',     uri: match.venue_url || 'https://maps.google.com' },
        ],
      },
    },
  ]);
}

// ⑩ 評価依頼通知（飲み終了後）
async function notifyRatingRequest(lineUserId, matchId) {
  await lineClient.pushMessage(lineUserId, [
    { type: 'text', text: '🍺 飲み会はいかがでしたか？\n\n評価を送っていただけると、コミュニティの向上に繋がります。' },
    {
      type: 'template',
      altText: '評価する',
      template: {
        type: 'buttons',
        text: '今夜の飲みを評価してください',
        actions: [
          { type: 'uri', label: '⭐ 評価する', uri: `${BASE_URL}/rating?match_id=${matchId}` },
        ],
      },
    },
  ]);
}

// ── 管理者向けAPI（admin.htmlから呼ぶ） ──────────────────
app.use(express.json());

// 審査承認
app.post('/api/approve', async (req, res) => {
  const { userId, lineUserId } = req.body;
  await supabase.from('users').update({ verify_status: 'approved' }).eq('id', userId);
  await notifyApproved(lineUserId);
  res.json({ ok: true });
});

// 審査否認
app.post('/api/reject', async (req, res) => {
  const { userId, lineUserId, reason } = req.body;
  await supabase.from('users').update({ verify_status: 'rejected', reject_reason: reason }).eq('id', userId);
  await notifyRejected(lineUserId, reason);
  res.json({ ok: true });
});

// マッチング成立
app.post('/api/match', async (req, res) => {
  const { maleRequestId, femaleRequestId, venueName, venueAddress, venueUrl, meetTime, area } = req.body;

  const { data: match } = await supabase.from('matches').insert({
    male_request_id:   maleRequestId,
    female_request_id: femaleRequestId,
    area, meet_time: meetTime,
    venue_name: venueName, venue_address: venueAddress, venue_url: venueUrl,
  }).select().single();

  // 両リクエストをmatched状態に
  await supabase.from('requests').update({ status: 'matched' })
    .in('id', [maleRequestId, femaleRequestId]);

  // 参加ユーザーを取得してLINE通知
  const { data: mReq } = await supabase.from('requests').select('users(line_user_id)').eq('id', maleRequestId).single();
  const { data: fReq } = await supabase.from('requests').select('users(line_user_id)').eq('id', femaleRequestId).single();

  if (mReq?.users?.line_user_id) await notifyMatched(mReq.users.line_user_id, match);
  if (fReq?.users?.line_user_id) await notifyMatched(fReq.users.line_user_id, match);

  // 運営にも通知
  await lineClient.pushMessage(process.env.ADMIN_LINE_USER_ID, {
    type: 'text', text: `✅ マッチング #${match.id} を成立させました\nエリア: ${area} / ${meetTime}`,
  });

  res.json({ ok: true, matchId: match.id });
});

// 評価依頼送信（飲み後に管理画面から叩く）
app.post('/api/notify-rating', async (req, res) => {
  const { matchId } = req.body;
  const { data: mu } = await supabase.from('match_users')
    .select('users(line_user_id)').eq('match_id', matchId);
  for (const row of mu || []) {
    if (row.users?.line_user_id) await notifyRatingRequest(row.users.line_user_id, matchId);
  }
  res.json({ ok: true });
});

// ── ヘルパー ──────────────────────────────────────────────
async function getUser(lineUserId) {
  const { data } = await supabase.from('users').select('*').eq('line_user_id', lineUserId).single();
  return data;
}

function reply(event, messages) {
  return lineClient.replyMessage(event.replyToken, messages);
}

// ── LINEメッセージテンプレート ────────────────────────────
function registerButton(userId) {
  return {
    type: 'template', altText: 'プロフィール登録',
    template: {
      type: 'buttons',
      title: 'GOEN 🍻',
      text: 'まずはプロフィールを登録してください',
      actions: [
        { type: 'uri', label: '📝 プロフィール登録', uri: `${BASE_URL}/register?uid=${userId}` },
      ],
    },
  };
}

function requestButton(userId) {
  return {
    type: 'template', altText: '飲みの希望を出す',
    template: {
      type: 'buttons',
      title: '今夜、誰かと飲もう 🍺',
      text: '希望エリア・時間・雰囲気を入力してください',
      actions: [
        { type: 'uri', label: '🍺 飲みの希望を出す', uri: `${BASE_URL}/request?uid=${userId}` },
        { type: 'uri', label: '👀 マイページ',       uri: `${BASE_URL}/mypage?uid=${userId}` },
      ],
    },
  };
}

function mypageButton(userId) {
  return {
    type: 'template', altText: 'マイページ',
    template: {
      type: 'buttons', text: 'マイページを確認する',
      actions: [
        { type: 'uri', label: '👤 マイページを開く', uri: `${BASE_URL}/mypage?uid=${userId}` },
      ],
    },
  };
}

function mainMenu() {
  return {
    type: 'template', altText: 'GOENメニュー',
    template: {
      type: 'buttons',
      title: 'GOEN 🍻', text: 'その瞬間、その場で繋がれる',
      actions: [
        { type: 'message', label: '📝 登録・プロフィール', text: '登録する' },
        { type: 'message', label: '🍺 飲みの希望を出す',  text: '飲みを探す' },
        { type: 'message', label: '👤 マイページ・状況確認', text: 'マイページ' },
      ],
    },
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🍻 GOEN Server running on port ${PORT}`));

module.exports = { notifyApproved, notifyRejected, notifyMatched, notifyRatingRequest };
