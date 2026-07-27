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
  w.document.getElementById('new-pin').value = '5555';
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

/* ---------- 9. 実名の混入防止 ---------- */
console.log('\n[9] 公開リポジトリの衛生');
{
  ok(!/空花|風花/.test(html), 'index.html に実名が含まれない');
}

/* ---------- 結果 ---------- */
console.log(`\n${'='.repeat(46)}`);
console.log(`  passed: ${passed}  failed: ${failed}`);
if (failed) { console.log('\n  失敗:'); fails.forEach(f => console.log('   - ' + f)); }
console.log(`${'='.repeat(46)}\n`);
process.exit(failed ? 1 : 0);
