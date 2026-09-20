import type { TokenSupportProvider, TokenSupportRecord } from "../domain/tokenSupportModels";
import type { PriceStorage, TokenSupportStoreInterface } from "../storage/PriceStorage";
import { SqlitePriceStorage, type GenericSqlExecutor } from "../storage/SqlitePriceStorage";

export class TokenSupportStore implements TokenSupportStoreInterface {
  private readonly store: TokenSupportStoreInterface;

  constructor(storage: PriceStorage | TokenSupportStoreInterface | GenericSqlExecutor) {
    if ("tokenSupport" in storage && typeof storage.tokenSupport === "object") {
      this.store = storage.tokenSupport;
    } else if ("loadAll" in storage && typeof storage.loadAll === "function") {
      this.store = storage as TokenSupportStoreInterface;
    } else {
      const sqliteStorage = SqlitePriceStorage.fromStorageAdapter(storage as GenericSqlExecutor);
      this.store = sqliteStorage.tokenSupport;
    }
  }

  loadAll(): Promise<readonly TokenSupportRecord[]> {
    return this.store.loadAll();
  }

  get(token: string, provider: TokenSupportProvider): Promise<TokenSupportRecord | null> {
    return this.store.get(token, provider);
  }

  set(token: string, provider: TokenSupportProvider, supported: boolean): void {
    const res = this.store.set(token, provider, supported);
    if (res && typeof (res as Promise<void>).catch === "function") {
      (res as Promise<void>).catch(() => undefined);
    }
  }

  async setBatch(records: readonly { token: string; provider: TokenSupportProvider; supported: boolean }[]): Promise<void> {
    if (this.store.setBatch) {
      await this.store.setBatch(records);
    } else {
      for (const r of records) {
        await this.store.set(r.token, r.provider, r.supported);
      }
    }
  }
}
