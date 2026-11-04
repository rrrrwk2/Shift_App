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
//   items:   問題がある項目だけ { key, label, level, text } の形で入る
//     level: "warn" … ○の人だけでは足りないが、△の人も入れば足りる
//            "ng"   … △の人を入れても足りない
//            "over" … 定員より多い
//   level:   その日全体の判定（ng → warn → over の順に強い）
//   targets: 項目ごとの目標人数（表の下に「3/5」のように出すため）
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

function judgeDay(date, count, rules) {
  const result = { level: "", items: [], targets: {} };
  if (rules.closed_weekdays.includes(weekdayOf(date))) return result; // チェックしない曜日

  // 足りないかどうかを調べて、足りなければ items に入れる
  const checkMin = (key, label, counter, need) => {
    result.targets[key] = need;
    const ok = count.ok[counter][date];
    const withMaybe = ok + count.maybe[counter][date];
    if (ok >= need) return;
    const level = withMaybe >= need ? "warn" : "ng";
    result.items.push({
      key,
      label,
      level,
      text: `${label} ${ok}/${need}人${level === "warn" ? "（△を入れれば足りる）" : ""}`,
    });
  };

  // 定員：少なすぎ（warn / ng）と多すぎ（over）
  const cap = capacityOf(date, rules);
  if (cap !== null) {
    const ok = count.ok.all[date];
    if (ok > cap) {
      result.targets.capacity = cap;
      result.items.push({ key: "capacity", label: "定員", level: "over", text: `定員 ${ok}/${cap}人（${ok - cap}人多い）` });
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

  const levels = result.items.map((i) => i.level);
  result.level = levels.includes("ng") ? "ng" : levels.includes("warn") ? "warn" : levels.includes("over") ? "over" : "";
  return result;
}
