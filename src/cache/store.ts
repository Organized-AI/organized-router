import { addReceipt, emptyStats, type Receipt, type Stats, type Store } from '../router/types';

async function remove(txn: DurableObjectTransaction, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 128) await txn.delete(keys.slice(i, i + 128));
}

export class DurableStore implements Store {
  constructor(private storage: DurableObjectStorage) {}
  get<T>(key: string): Promise<T | undefined> { return this.storage.get<T>(key); }
  async epoch(): Promise<number> { return (await this.storage.get<number>('epoch')) ?? 0; }
  async delete(key: string): Promise<void> { await this.storage.delete([key, 'm:' + key]); }
  async putBounded<T extends { expiresAt: number }>(prefix: string, key: string, value: T, limit: number, epoch: number): Promise<void> {
    await this.storage.transaction(async txn => {
      if (((await txn.get<number>('epoch')) ?? 0) !== epoch) return;
      // List expiry metadata, never all cached response payloads. A large cache
      // must not materialize its entire persistent contents in the isolate.
      const rows = await txn.list<{ expiresAt: number }>({ prefix: 'm:' + prefix });
      const expired = [...rows].filter(([, row]) => row.expiresAt <= Date.now()).map(([id]) => id);
      if (expired.length) { await remove(txn, expired.flatMap(id => [id, id.slice(2)])); expired.forEach(id => rows.delete(id)); }
      rows.delete('m:' + prefix + key);
      const evict = [...rows].sort((a, b) => a[1].expiresAt - b[1].expiresAt).slice(0, Math.max(0, rows.size - limit + 1)).map(([id]) => id);
      if (evict.length) await remove(txn, evict.flatMap(id => [id, id.slice(2)]));
      await txn.put(prefix + key, value);
      await txn.put('m:' + prefix + key, { expiresAt: value.expiresAt });
      // Alarms remove expired payloads even when this tenant stops making requests.
      const alarm = await txn.getAlarm();
      if (alarm === null || alarm > value.expiresAt) await txn.setAlarm(value.expiresAt);
    });
  }
  async clear(): Promise<void> {
    await this.storage.transaction(async txn => {
      await txn.put('epoch', ((await txn.get<number>('epoch')) ?? 0) + 1);
      for (const prefix of ['c:', 'a:']) {
        const keys = [...(await txn.list({ prefix: 'm:' + prefix })).keys()];
        await remove(txn, keys.flatMap(id => [id, id.slice(2)]));
      }
      await txn.deleteAlarm();
    });
  }
  async record(receipt: Receipt): Promise<void> {
    await this.storage.transaction(async txn => {
      await txn.put('stats', addReceipt((await txn.get<Stats>('stats')) ?? emptyStats(), receipt));
    });
  }
  async stats(): Promise<Stats> { return (await this.storage.get<Stats>('stats')) ?? emptyStats(); }
  async inventory(): Promise<{ responseEntries: number; affinityEntries: number }> {
    return { responseEntries: (await this.storage.list({ prefix: 'm:c:' })).size,
      affinityEntries: (await this.storage.list({ prefix: 'm:a:' })).size };
  }
  async sweep(): Promise<void> {
    await this.storage.transaction(async txn => {
      let next = Infinity;
      for (const prefix of ['c:', 'a:']) {
        const rows = await txn.list<{ expiresAt: number }>({ prefix: 'm:' + prefix });
        const expired: string[] = [];
        for (const [key, value] of rows) {
          if (value.expiresAt <= Date.now()) expired.push(key);
          else next = Math.min(next, value.expiresAt);
        }
        await remove(txn, expired.flatMap(id => [id, id.slice(2)]));
      }
      if (Number.isFinite(next)) await txn.setAlarm(next);
    });
  }
}
