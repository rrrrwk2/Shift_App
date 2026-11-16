// =========================================================
// 一覧画面とシフト作成画面の両方で使う「判定」と「表示名」
// （作成担当用の画面だけで読み込む。スタッフ側では使わない）
// =========================================================

// 性別・レベルの表示（作成担当だけが見る）
const GENDER_SHORT = { male: "男", female: "女" };
const LEVEL_SHORT = { new: "新人", regular: "通常", veteran: "ベテラン" };

// 週の日数の希望を文章にする
function weeklyText(sub) {
  const min = sub.min_days_per_week;
  const max = sub.max_days_per_week;
  if (min && max) return min === max ? `週${min}日` : `週${min}〜${max}日`;
  if (min) return `週${min}日以上`;
  if (max) return `週${max}日まで`;
  return "-";
}

// ---------------------------------------------------------
// 毎日のルールの判定
//
// 1日ごとに、項目（定員・男性・女性・ベテラン）ごとの判定をまとめて返す
//   checks:  項目ごとの判定 { capacity: "good", male: "warn", ... }（チェックしない項目は入らない）
//            "good" … 条件どおり（うすい緑）
//            "warn" … 惜しい：あと1人足りない・1人多い、または△の人も入れば足りる（黄色）
//            "ng"   … 2人以上足りない・多い（赤）
//   items:   問題がある項目（warn・ng）だけ { key, label, level, text } の形で入る
//   level:   その日全体の判定（いちばん悪い項目。ng → warn → good）
//   targets: 項目ごとの目標人数（表の下に「3/5」のように出すため）
//
// options.overIsOk … 定員より多くても問題にしない
//   （希望の一覧では、○の人が定員より多いのは「選べる人が多い」だけなので条件どおり扱い）
// ---------------------------------------------------------
const MIN_ITEMS = [
  { key: "male", rule: "min_male", label: "男性" },
  { key: "female", rule: "min_female", label: "女性" },
  { key: "veteran", rule: "min_veteran", label: "ベテラン" },
];

// その日の定員（祝日なら祝日の人数、そうでなければ曜日の人数）
function capacityOf(date, rules) {
  const key = isHoliday(date) ? "holiday" : String(weekdayOf(date));
  const cap = rules.capacity?.[key];
  return cap === undefined ? null : cap;
}

function judgeDay(date, count, rules, options = {}) {
  const result = { level: "", items: [], targets: {}, checks: {} };
  if (rules.closed_weekdays.includes(weekdayOf(date))) return result; // チェックしない曜日

  // 項目の判定を記録する（問題があるものは items にも入れる）
  const add = (key, label, level, text = "") => {
    result.checks[key] = level;
    if (level !== "good") result.items.push({ key, label, level, text });
  };

  // 足りているかを調べる
  //   足りている → good、あと1人 or △の人も入れば足りる → warn、それ以外 → ng
  const checkMin = (key, label, counter, need) => {
    result.targets[key] = need;
    const ok = count.ok[counter][date];
    if (ok >= need) return add(key, label, "good");
    const short = need - ok;
    const coveredByMaybe = ok + count.maybe[counter][date] >= need;
    const level = short === 1 || coveredByMaybe ? "warn" : "ng";
    add(key, label, level, `${label} ${ok}/${need}人（${coveredByMaybe ? "△を入れれば足りる" : `あと${short}人`}）`);
  };

  // 定員：少なすぎと多すぎ（1人多いだけなら warn、2人以上多いなら ng）
  const cap = capacityOf(date, rules);
  if (cap !== null) {
    const ok = count.ok.all[date];
    if (ok > cap && !options.overIsOk) {
      result.targets.capacity = cap;
      const over = ok - cap;
      add("capacity", "定員", over === 1 ? "warn" : "ng", `定員 ${ok}/${cap}人（${over}人多い）`);
    } else {
      checkMin("capacity", "定員", "all", cap);
    }
  }

  // 最低限必要な人数（男性・女性・ベテラン）
  for (const item of MIN_ITEMS) {
    const need = rules[item.rule];
    if (need === null || need === undefined) continue; // この項目はチェックしない
    checkMin(item.key, item.label, item.key, need);
  }

  const levels = Object.values(result.checks);
  result.level = levels.includes("ng") ? "ng" : levels.includes("warn") ? "warn" : levels.length ? "good" : "";
  return result;
}
