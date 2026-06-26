// シンプルなテクニカル指標。終値配列（古い→新しい順）を入力に取る。

/** 単純移動平均（直近 period 本）。データ不足なら null。 */
export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** RSI（Wilder簡易版・直近 period 本）。0-100。データ不足なら null。 */
export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** 指定期間の騰落率（%）。最初と最後の終値を比較。 */
export function changePct(values: number[]): number | null {
  if (values.length < 2) return null;
  const first = values[0];
  const last = values[values.length - 1];
  if (first === 0) return null;
  return ((last - first) / first) * 100;
}

/** 終値配列から主要指標をまとめて算出。 */
export function summarize(closes: number[]) {
  return {
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    rsi14: rsi(closes, 14),
  };
}
