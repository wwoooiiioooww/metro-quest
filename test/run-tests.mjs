/* 地下鉄クエスト 自動テスト(jsdom)
   実行: cd test && npm install && npm test
   主目的: localStorageキーの名前空間化(v5)で、
     (a) 旧v4データが失われないこと
     (b) 同一オリジンの姉妹アプリのキーを壊さないこと
   の再発防止。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const swjs = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name); }
}
function eq(a, b, name) {
  const same = Object.is(a, b);
  ok(same, name + (same ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));
}

/* 起動ヘルパー。ls=起動前に仕込むlocalStorage */
function boot(ls) {
  const errors = [];
  const alerts = [];
  const dom = new JSDOM(html, {
    url: 'https://example.com/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.confirm = () => true;
      window.alert = m => alerts.push(String(m));
      window.scrollTo = () => {}; // jsdom未実装。本物のエラーを埋もれさせないため潰す
      window.addEventListener('error', e => errors.push(e.message));
      if (ls) Object.entries(ls).forEach(([k, v]) => window.localStorage.setItem(k, v));
    },
  });
  return { dom, w: dom.window, errors, alerts };
}

/* v4時代の実データを模したもの */
const LEGACY = {
  questSettings: JSON.stringify({
    areas: ['tokyo23'], lines: ['A', 'I'], spinsPerDay: 7,
    targets: [{ label: 'そら', w: 40 }], money: [{ label: '10円', w: 1 }], missions: ['テスト指令'],
  }),
  spinsLeft: '3',
  excludedStations: JSON.stringify(['新橋', '大手町']),
  questHistory: JSON.stringify([{ station: '浅草', mission: 'テスト指令', money: '100円', target: 'そら', time: '10:00' }]),
  totalMoney: '450',
  parentPin: '9876',
};

/* ---------- 1. 新規ユーザー ---------- */
console.log('\n[1] 新規ユーザー(旧データなし)');
{
  const { w, errors } = boot();
  const store = JSON.parse(w.localStorage.getItem('mq_v1') || 'null');
  ok(w.eval('store') !== null, '起動して store が初期化される');
  eq(w.eval('totalMoney'), 0, '合計金額は0から始まる');
  eq(w.eval('spinsLeft'), w.eval('settings.spinsPerDay'), '残り回数はデフォルトのspinsPerDay');
  ok(store === null, '何もしないうちは mq_v1 を書き込まない(migrate対象がないため)');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 2. v4 → v5 移行(本体) ---------- */
console.log('\n[2] v4旧キーからの移行');
{
  const { w, errors } = boot(LEGACY);
  const store = JSON.parse(w.localStorage.getItem('mq_v1'));

  ok(store !== null, '起動時に mq_v1 が作られる');
  eq(store.totalMoney, 450, '合計金額が引き継がれる');
  eq(store.spinsLeft, 3, '残り回数が引き継がれる');
  eq(store.pin, '9876', 'PINが引き継がれる');
  eq(store.excluded.length, 2, '除外駅が引き継がれる(件数)');
  ok(store.excluded.includes('新橋') && store.excluded.includes('大手町'), '除外駅が引き継がれる(中身)');
  eq(store.history.length, 1, '記録が引き継がれる(件数)');
  eq(store.history[0].station, '浅草', '記録が引き継がれる(中身)');
  eq(store.settings.spinsPerDay, 7, '設定が引き継がれる');
  eq(store.settings.missions[0], 'テスト指令', 'カスタム指令が引き継がれる');

  /* 実行中の変数にも反映されているか */
  eq(w.eval('totalMoney'), 450, '画面側の合計金額も450');
  eq(w.eval('spinsLeft'), 3, '画面側の残り回数も3');
  eq(w.eval('getPin()'), '9876', 'getPin()が移行後のPINを返す');
  eq(w.eval('settings.spinsPerDay'), 7, 'settingsが移行後の値');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 3. 旧キーを削除しない(1バージョンは併存) ---------- */
console.log('\n[3] 旧キーの保持');
{
  const { w } = boot(LEGACY);
  eq(w.localStorage.getItem('totalMoney'), '450', '移行後も旧キーを削除しない(ロールバック用)');
  eq(w.localStorage.getItem('parentPin'), '9876', '旧PINキーも残る');
  w.close();
}

/* ---------- 4. 二重移行しない ---------- */
console.log('\n[4] 二重移行の防止');
{
  /* 既にv5で遊んだあと、旧キーも残っている状態 */
  const already = { totalMoney: 9999, spinsLeft: 1, excluded: [], history: [], settings: null, pin: '1111' };
  const { w, errors } = boot({ ...LEGACY, mq_v1: JSON.stringify(already) });
  eq(w.eval('totalMoney'), 9999, 'mq_v1がある場合は旧キーで上書きしない');
  eq(w.eval('getPin()'), '1111', 'PINもmq_v1側が優先される');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 5. 壊れた/部分的な旧データ ---------- */
console.log('\n[5] 欠損・破損データへの耐性');
{
  const { w, errors } = boot({ totalMoney: '120' }); // 旧キーが1つだけ
  const store = JSON.parse(w.localStorage.getItem('mq_v1'));
  eq(store.totalMoney, 120, '旧キーが一部だけでも移行できる');
  eq(store.history.length, 0, '欠けている項目は空で埋まる');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  const { w, errors } = boot({ questHistory: '{壊れたJSON', totalMoney: '50' });
  const store = JSON.parse(w.localStorage.getItem('mq_v1'));
  eq(store.history.length, 0, '壊れたJSONは空配列に落とす');
  eq(store.totalMoney, 50, '壊れた項目があっても他は移行される');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  const { w, errors } = boot({ mq_v1: 'not json at all' });
  ok(w.eval('store') !== null, 'mq_v1自体が壊れていても起動できる');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 6. 姉妹アプリのキーを壊さない(本命の再発防止) ---------- */
console.log('\n[6] 同一オリジンの姉妹アプリとの分離');
{
  /* GitHub Pagesでは姉妹アプリが同一オリジン。
     一般名のキーを他アプリが持っていても、地下鉄クエストは触ってはいけない。 */
  const sisters = {
    studykichi_v1: '{"sister":"study"}',
    'hk.state.v1': '{"sister":"health"}',
    cosmos_co_progress_v1: '{"sister":"cosmos"}',
    questHistory: '[{"sister":"other-app"}]',
    parentPin: '0000',
  };
  const { w, errors } = boot(sisters);

  /* 起動 → 除外駅の追加・PIN変更・記録リセットまで一通り操作する */
  w.eval('addExclude("渋谷")');
  w.document.getElementById('parent-code').value = '5555';
  w.eval('changePin()');
  w.eval('clearHistory()');

  eq(w.localStorage.getItem('studykichi_v1'), '{"sister":"study"}', 'スタディきちのキーを壊さない');
  eq(w.localStorage.getItem('hk.state.v1'), '{"sister":"health"}', 'ヘルスきちのキーを壊さない');
  eq(w.localStorage.getItem('cosmos_co_progress_v1'), '{"sister":"cosmos"}', 'kids-eduのキーを壊さない');
  eq(w.localStorage.getItem('questHistory'), '[{"sister":"other-app"}]', '一般名のキーに書き戻さない');
  eq(w.localStorage.getItem('parentPin'), '0000', '他アプリのPINを書き換えない');
  eq(JSON.parse(w.localStorage.getItem('mq_v1')).pin, '5555', '自分のPINは mq_v1 側に保存される');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* アプリが作るキーは mq_ 接頭辞のものだけであること */
  const { w, errors } = boot();
  w.eval('addExclude("上野")');
  w.eval('spinsLeft = 5; store.spinsLeft = spinsLeft; saveStore();');
  const keys = Object.keys(w.localStorage).filter(k => k.length);
  const bad = keys.filter(k => !k.startsWith('mq_'));
  eq(bad.length, 0, `アプリが作るキーは mq_ 接頭辞のみ (作られたキー: ${JSON.stringify(keys)})`);
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 7. 保存が実際に効くか ---------- */
console.log('\n[7] 保存の往復');
{
  const { w } = boot();
  w.eval('addExclude("五反田")');
  const saved = JSON.parse(w.localStorage.getItem('mq_v1'));
  ok(saved.excluded.includes('五反田'), '除外駅の追加が mq_v1 に保存される');
  w.close();

  /* 保存された状態で再起動して復元されるか */
  const { w: w2, errors } = boot({ mq_v1: JSON.stringify(saved) });
  ok(w2.eval('excludedStations').includes('五反田'), '再起動後も除外駅が復元される');
  eq(errors.length, 0, 'runtime errors: none');
  w2.close();
}
{
  /* resetExcluded は変数を再代入するので、store側にも反映されている必要がある */
  const { w } = boot({ mq_v1: JSON.stringify({ ...JSON.parse('{}'), excluded: ['浅草', '銀座'], history: [], totalMoney: 0, settings: null, spinsLeft: null, pin: null }) });
  w.eval('resetExcluded()');
  const saved = JSON.parse(w.localStorage.getItem('mq_v1'));
  eq(saved.excluded.length, 0, '除外の全解除が保存に反映される(変数再代入のとりこぼしなし)');
  w.close();
}
{
  /* removeExcluded も filter で再代入する */
  const { w } = boot({ mq_v1: JSON.stringify({ excluded: ['浅草', '銀座'], history: [], totalMoney: 0, settings: null, spinsLeft: null, pin: null }) });
  w.eval('removeExcluded("浅草")');
  const saved = JSON.parse(w.localStorage.getItem('mq_v1'));
  eq(saved.excluded.length, 1, '除外の個別解除が保存に反映される');
  eq(saved.excluded[0], '銀座', '残る駅が正しい');
  w.close();
}

/* ---------- 8. バージョン表示とキャッシュキーの一致 ---------- */
console.log('\n[8] バージョンとキャッシュキー');
{
  const vApp = (html.match(/APP_VER\s*=\s*'v(\d+)'/) || [])[1];
  const vSw = (swjs.match(/CACHE_NAME\s*=\s*'metro-quest-v(\d+)'/) || [])[1];
  ok(vApp !== undefined, 'index.html に APP_VER がある');
  ok(vSw !== undefined, 'sw.js に CACHE_NAME がある');
  eq(vApp, vSw, `APP_VER(v${vApp}) と sw.js CACHE_NAME(v${vSw}) が一致する`);

  const { w } = boot();
  eq(w.document.getElementById('app-ver').textContent, '地下鉄クエスト v' + vApp, '画面にバージョンが表示される');
  w.close();
}

/* ---------- 9b. 日付ごとの集計(v6) ---------- */
console.log('\n[9b] 今日の分と累計');
{
  const d = new Date();
  const T = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const st = {
    settings:null, spinsLeft:null, excluded:[], pin:null, totalMoney: 900,
    history: [
      { station:'上野', money:'100円', date:T,            time:'10:00' },
      { station:'銀座', money:'200円', date:T,            time:'11:00' },
      { station:'浅草', money:'300円', date:'2020-01-01', time:'12:00' },
      { station:'新橋', money:'300円',                    time:'13:00' }, // v5以前(日付なし)
    ],
  };
  const { w, errors } = boot({ mq_v1: JSON.stringify(st) });
  const total = w.document.getElementById('total-money').innerText;
  const rank  = w.document.getElementById('rank').textContent;

  ok(total.includes('今日:300円'), `今日の合計は今日の記録だけ (${total})`);
  ok(total.includes('累計:900円'), '累計はこれまで通り保持される');
  ok(rank.includes('クリア4回'), `累計のクリア回数は日付の有無に関係なく全件 (${rank})`);
  ok(rank.includes('ぼうけん2日'), `冒険日数は日付のある記録から算出 (${rank})`);
  eq(w.eval('history.length'), 4, '古い記録が自動で消えない(リセットしない)');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 日付の無い記録しかない場合、日数は表示しない(推測で埋めない) */
  const st = { settings:null, spinsLeft:null, excluded:[], pin:null, totalMoney: 100,
               history: [{ station:'上野', money:'100円', time:'10:00' }] };
  const { w } = boot({ mq_v1: JSON.stringify(st) });
  const rank = w.document.getElementById('rank').textContent;
  ok(!rank.includes('ぼうけん'), `日付不明なら日数を出さない (${rank})`);
  ok(w.document.getElementById('total-money').innerText.includes('今日:0円'), '日付の無い記録は今日に数えない');
  w.close();
}
{
  /* 新しく達成した記録には日付が入る */
  const { w } = boot();
  w.eval('currentResult = {station:"上野", mission:"テスト", money:"100円", target:"そら"}');
  w.eval('clearMission()');
  const h = JSON.parse(w.localStorage.getItem('mq_v1')).history[0];
  ok(!!h.date && /^\d{4}-\d{2}-\d{2}$/.test(h.date), `新しい記録に日付が入る (${h.date})`);
  ok(!!h.time, '時刻も従来通り入る');
  ok(w.document.getElementById('total-money').innerText.includes('今日:100円'), '今日の合計に即反映される');
  w.close();
}

/* ---------- 9c. 音の解除・自動入力の抑止 ---------- */
console.log('\n[9c] 音と入力欄');
{
  const { w, errors } = boot();
  eq(w.eval('typeof unlockAudio'), 'function', 'unlockAudio がある');
  eq(w.eval('(function(){try{beep(440,0.1);return "ok"}catch(e){return e.message}})()'), 'ok',
     'AudioContext非対応環境でも beep が例外を投げない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();

  const pin = html.match(/<input[^>]*id="parent-code"[^>]*>/s)[0];
  ok(/autocomplete="off"/.test(pin), 'PIN入力に autocomplete="off" がある');
}

/* ---------- 9. 実名の混入防止 ---------- */
console.log('\n[9] 公開リポジトリの衛生');
{
  ok(!/空花|風花/.test(html), 'index.html に実名が含まれない');
}


/* ---------- 10. 称号 ---------- */
console.log('\n[10] 称号');
{
  const { w, errors } = boot();
  const R = w.eval('RANKS');
  eq(R.length, 5, '称号は5段階');
  eq(w.eval('getRank(0)'),   R[0].label, 'クリア0回はスタートの称号');
  eq(w.eval('getRank(4)'),   R[1].label, 'クリア4回は2番目');
  eq(w.eval('getRank(5)'),   R[2].label, 'クリア5回で3番目に上がる');
  eq(w.eval('getRank(999)'), R[4].label, 'しきい値を大きく超えても最高位');
  eq(w.eval('nextRank(4).n'), 5, '次の称号のしきい値がわかる');
  eq(w.eval('nextRank(15)'), null, '最高位なら次はない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* クリア6回 = 3番目の称号が現在地 */
  const st = { settings:null, spinsLeft:null, excluded:[], pin:null, totalMoney:0,
    history: Array.from({ length: 6 }, () => ({ station:'x', money:'1', date:'2020-01-01' })) };
  const { w, errors } = boot({ mq_v1: JSON.stringify(st) });
  w.eval('openRanks()');
  eq(w.document.getElementById('ranks').style.display, 'block', '称号一覧が開く');
  eq(w.document.querySelectorAll('#ranks-list .rank-row').length, 5, '全5段階が並ぶ');
  eq(w.document.querySelectorAll('#ranks-list .rank-row.now').length, 1, '現在地が1つだけ強調される');
  ok(w.document.querySelector('#ranks-list .rank-row.now').textContent.includes('いっちょまえ'),
     'クリア6回なら3番目が現在地');
  ok(w.document.getElementById('ranks-next').innerText.includes('あと 4回'),
     `次の称号まであと何回か出る (${w.document.getElementById('ranks-next').innerText})`);
  w.eval('closeRanks()');
  eq(w.document.getElementById('ranks').style.display, 'none', 'とじられる');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  const { w } = boot();
  const rank = w.document.getElementById('rank');
  ok(rank.innerHTML.includes('openRanks'), 'ヘッダーから称号一覧を開ける');
  ok(rank.textContent.trim().startsWith('🥚'), `称号が先頭に来る (${rank.textContent})`);
  ok(rank.textContent.includes('クリア0回'), 'クリア回数が併記される');
  w.close();
}

/* ---------- 11. 重みと実際の割合 ---------- */
console.log('\n[11] 重みの割合表示');
{
  const { w, errors } = boot();
  w.eval('settings.targets = [{label:"A",w:40},{label:"B",w:40},{label:"C",w:20}]');
  w.eval('renderWeightEditor("target-editor", settings.targets)');
  eq(w.document.getElementById('target-editor-pct-0').textContent, '40%', '合計100なら 40 は 40%');

  /* 「合計が100を超えると効かない」という誤解の再発防止。
     実際は合計に対する割合として正しく効く */
  w.eval('editItem("target-editor",0,"w",80)');
  eq(w.document.getElementById('target-editor-pct-0').textContent, '57.1%', '80/140 → 57.1%(頭打ちにならない)');
  eq(w.document.getElementById('target-editor-pct-1').textContent, '28.6%', '他の項目の割合は下がる');
  ok(w.document.getElementById('target-editor-total').textContent.includes('140'), '重みの合計が表示される');

  /* 抽選そのものも合計に追従しているか(100超で偏ること) */
  w.eval('settings.targets = [{label:"A",w:1000},{label:"B",w:1}]');
  let a = 0;
  for (let i = 0; i < 200; i++) if (w.eval('weightedPick(settings.targets)') === 'A') a++;
  ok(a > 180, `重み1000対1なら大きく偏る (Aが200回中${a}回)`);
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  const { w, errors } = boot();
  w.eval('settings.targets = [{label:"A",w:0},{label:"B",w:0}]');
  w.eval('renderWeightEditor("target-editor", settings.targets)');
  eq(w.document.getElementById('target-editor-pct-0').textContent, '—', '重みが全部0なら % を出さない');
  ok(w.document.getElementById('target-editor-total').textContent.includes('0です'), '全部0のときは注意を出す');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* ラベルに引用符やタグが入っても編集欄が壊れない */
  const { w, errors } = boot();
  const weird = 'あ"い<b>&';
  w.eval('settings.targets = [{label:' + JSON.stringify(weird) + ',w:10}]');
  w.eval('renderWeightEditor("target-editor", settings.targets)');
  const inp = w.document.querySelector('#target-editor input[type=text]');
  eq(inp.value, weird, 'ラベルの引用符・タグでエディタが壊れない(esc)');
  eq(w.document.querySelectorAll('#target-editor .edit-row').length, 1, '余計な要素が生えない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 12. 表示文言とタイトル ---------- */
console.log('\n[12] 文言とタイトル');
{
  ok(!/ぜんぶ:/.test(html), '「ぜんぶ」表記が残っていない');
  const { w } = boot();
  const total = w.document.getElementById('total-money').innerText;
  ok(total.includes('累計:'), `「累計」表記になっている (${total})`);
  ok(total.includes('今日:'), '「今日」も併記される');
  w.close();

  const h1css = html.match(/h1 \{[^}]*\}/s)[0];
  ok(/white-space:nowrap/.test(h1css), 'タイトルが折り返さない');
  ok(/clamp\(/.test(h1css), '狭い画面でタイトルが縮む');
  const title = html.match(/<h1[^>]*>([^<]*)<\/h1>/)[1];
  ok([...title].length <= 14, `タイトルが十分短い (${title} = ${[...title].length}文字)`);
}

/* ---------- 13. 自動入力バーの抑止(第1段階) ---------- */
console.log('\n[13] 自動入力バーの抑止');
{
  ok(!/id="new-pin"/.test(html), 'idから "pin" を外した(パスワードマネージャ対策)');
  const forms = html.match(/<form[^>]*>/g) || [];
  ok(forms.length >= 1, '残った入力欄は form で包まれている');
  ok(forms.every(f => /autocomplete="off"/.test(f)), 'form に autocomplete="off" がある');
  /* 自動入力バー(鍵/カード/住所)はOS側が <input> に対して出すため、
     属性では抑止しきれなかった。駅名の自由入力欄そのものを廃止した */
  ok(!/pre-exclude-input/.test(html), '駅名の自由入力欄を廃止した');
  ok(!/<datalist/.test(html), '駅名のdatalistも残っていない');
  ok(!/function preExclude/.test(html), '未使用になった preExclude() が残っていない');
  const pc = html.match(/<input[^>]*id="parent-code"[^>]*>/s)[0];
  ok(/name="mq-/.test(pc), 'あいことば入力の name も同様');

  /* 参照の付け替え漏れがないこと */
  const { w, errors } = boot();
  w.document.getElementById('parent-code').value = '7777';
  w.eval('changePin()');
  eq(w.eval('getPin()'), '7777', 'あいことばの変更が動く(id変更の追従漏れなし)');
  eq(w.document.getElementById('parent-code').value, '', '入力欄がクリアされる');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}



/* ---------- 14. 画面下タブ ---------- */
console.log('\n[14] 画面下タブ');
{
  const { w, errors } = boot();
  ok(w.document.getElementById('tabbar'), 'タブバーがある');
  eq(w.document.querySelectorAll('#tabbar button').length, 3, 'タブは3つ');
  ok(w.document.getElementById('tab-play').classList.contains('on'), '起動時は「あそぶ」タブ');
  ok(!w.document.getElementById('tab-set').classList.contains('on'), '設定タブは閉じている');

  w.eval('switchTab("log")');
  ok(w.document.getElementById('tab-log').classList.contains('on'), 'きろくタブに切り替わる');
  ok(!w.document.getElementById('tab-play').classList.contains('on'), '前のタブは閉じる');
  ok(w.document.getElementById('nav-log').classList.contains('on'), 'タブバーの選択状態も追従する');
  eq(w.document.querySelectorAll('.tab-pane.on').length, 1, '同時に開くのは1つだけ');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 設定タブはあいことばで守られる */
  const { w, errors } = boot();
  w.prompt = () => '9999';                    // 間違ったあいことば
  w.eval('switchTab("set")');
  ok(!w.document.getElementById('tab-set').classList.contains('on'), '違うあいことばでは設定タブが開かない');
  w.prompt = () => '1234';                    // 既定のあいことば
  w.eval('switchTab("set")');
  ok(w.document.getElementById('tab-set').classList.contains('on'), '正しいあいことばで開く');
  eq(w.eval('parentAuthed'), true, '一度通れば認証済みになる');
  w.eval('switchTab("play")');
  w.prompt = () => { throw new Error('二度目は聞かれないはず'); };
  w.eval('switchTab("set")');
  ok(w.document.getElementById('tab-set').classList.contains('on'), '2回目はあいことばを聞かれない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* キャンセルしたら開かない */
  const { w } = boot();
  w.prompt = () => null;
  w.eval('switchTab("set")');
  ok(!w.document.getElementById('tab-set').classList.contains('on'), 'キャンセルでは開かない');
  w.close();
}

/* ---------- 15. 指令リストの行編集 ---------- */
console.log('\n[15] 指令リストの行編集');
{
  const { w, errors } = boot();
  w.eval('renderMissionEditor()');
  const rows = w.document.querySelectorAll('#mission-editor .edit-row');
  eq(rows.length, w.eval('settings.missions.length'), '指令の数だけ行が出る');
  eq(rows.length, w.eval('DEFAULT_MISSIONS.length'), `初期指令がすべて出る (${rows.length}件)`);
  ok(!/<textarea id="mission-editor"/.test(html), 'テキストエリアではなくなっている');

  /* 1行だけ書きかえる */
  w.eval('editMission(0, "テスト指令にへんこう")');
  eq(w.eval('settings.missions[0]'), 'テスト指令にへんこう', '1行だけ書きかえられる');

  /* 追加は先頭に入る(スマホでスクロールせずに済むように) */
  const before = w.eval('settings.missions.length');
  w.eval('addMissionRow()');
  eq(w.eval('settings.missions.length'), before + 1, '指令を追加できる');
  eq(w.eval('settings.missions[0]'), 'あたらしい指令', '追加した指令は先頭に入る');

  /* 削除 */
  w.eval('delMission(0)');
  eq(w.eval('settings.missions.length'), before, '指令を削除できる');
  eq(w.eval('settings.missions[0]'), 'テスト指令にへんこう', '正しい行が消える');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 最後の1件は消せない */
  const { w, alerts } = boot();
  w.eval('settings.missions = ["ひとつだけ"]');
  w.eval('renderMissionEditor()');
  w.eval('delMission(0)');
  eq(w.eval('settings.missions.length'), 1, '最後の1件は削除できない');
  ok(alerts.some(a => a.includes('最低1つ')), '理由がユーザーに伝わる');
  w.close();
}
{
  /* 保存時に空白行が落ちる。全部消えたら初期リストへ戻る */
  const { w } = boot();
  w.eval('settings.missions = ["のこす", "   ", ""]');
  w.eval('saveSettings()');
  eq(w.eval('settings.missions.length'), 1, '空白だけの指令は保存時に落ちる');
  eq(w.eval('settings.missions[0]'), 'のこす', '中身のある指令は残る');
  w.close();
}
{
  const { w } = boot();
  w.eval('settings.missions = ["  ", ""]');
  w.eval('saveSettings()');
  eq(w.eval('settings.missions.length'), w.eval('DEFAULT_MISSIONS.length'), '全部空なら初期リストに戻る');
  w.close();
}
{
  /* 指令に引用符が入っても編集欄が壊れない */
  const { w } = boot();
  w.eval('settings.missions = [' + JSON.stringify('"あぶない"<b>指令') + ']');
  w.eval('renderMissionEditor()');
  eq(w.document.querySelector('#mission-editor input').value, '"あぶない"<b>指令', '引用符やタグでも壊れない');
  eq(w.document.querySelectorAll('#mission-editor .edit-row').length, 1, '余計な行が生えない');
  w.close();
}
{
  /* 保存すると「あそぶ」タブへ戻る */
  const { w } = boot();
  w.prompt = () => '1234';
  w.eval('switchTab("set")');
  w.eval('saveSettings()');
  ok(w.document.getElementById('tab-play').classList.contains('on'), '保存後は「あそぶ」タブへ戻る');
  w.close();
}

/* ---------- 結果 ---------- */
console.log(`\n${'='.repeat(46)}`);
console.log(`  passed: ${passed}  failed: ${failed}`);
if (failed) { console.log('\n  失敗:'); fails.forEach(f => console.log('   - ' + f)); }
console.log(`${'='.repeat(46)}\n`);
process.exit(failed ? 1 : 0);
