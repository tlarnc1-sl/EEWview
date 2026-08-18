import { describe, expect, it } from 'vitest';
import { Clock } from '../src/clock';

describe('Clock', () => {
  it('推定できていないことを隠さない', () => {
    const clock = new Clock(() => 1_000);
    expect(clock.offsetMs).toBeNull();
    expect(clock.status).toBe('unknown');
    // 推定できなくてもローカル時計は返す（止まらない）
    expect(clock.now()).toBe(1_000);
  });

  it('往復時間の半分を引いてオフセットを出す', () => {
    const clock = new Clock(() => 0);
    // 送信 1000、受信 1200（RTT 200ms）、サーバー時刻 5100
    clock.addSample(5_100, 1_000, 1_200);
    expect(clock.offsetMs).toBe(4_000);
    expect(clock.rttMs).toBe(200);
    expect(clock.status).toBe('ok');
  });

  it('外れ値を中央値で排除する', () => {
    const clock = new Clock(() => 0);
    clock.addSample(1_000, 0, 100);
    clock.addSample(1_010, 0, 100);
    clock.addSample(9_000, 0, 100); // 外れ値
    expect(clock.offsetMs).toBe(960);
  });

  it('往復が長すぎるサンプルは使わない', () => {
    const clock = new Clock(() => 0);
    clock.addSample(1_000, 0, 20_000);
    expect(clock.sampleCount).toBe(0);
  });

  it('ずれが大きすぎるときは suspect にして表に出す', () => {
    const clock = new Clock(() => 0);
    clock.addSample(500_000, 0, 100);
    expect(clock.status).toBe('suspect');
  });

  it('NaN を持ち込まない', () => {
    const clock = new Clock(() => 0);
    clock.addSample(Number.NaN, 0, 100);
    clock.addHttpSample('壊れた日付', 0, 100);
    clock.addHttpSample(null, 0, 100);
    expect(clock.sampleCount).toBe(0);
    expect(Number.isFinite(clock.now())).toBe(true);
  });

  it('HTTPの Date ヘッダからサンプルを取る', () => {
    const clock = new Clock(() => 0);
    const serverTime = Date.parse('2026-08-16T10:00:00Z');
    clock.addHttpSample('Sun, 16 Aug 2026 10:00:00 GMT', serverTime, serverTime + 200);
    // Date は秒単位なので半秒補正が入る。ずれは1秒未満に収まる
    expect(Math.abs(clock.offsetMs!)).toBeLessThan(1_000);
  });
});
