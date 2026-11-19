import { Location } from '@angular/common';
import { inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';

type HistoryEntry = { session: string; index: number };
type BrowserState = { icashHistory?: HistoryEntry };

@Injectable({ providedIn: 'root' })
export class PageHistory {
  private readonly location = inject(Location);
  private readonly router = inject(Router);
  private session = crypto.randomUUID();
  private index = -1;
  private last = -1;
  readonly canBack = signal(false);
  readonly canForward = signal(false);

  constructor() {
    let restored: HistoryEntry | undefined;
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof NavigationStart) {
        restored = (event.restoredState as BrowserState | null)?.icashHistory;
      } else if (event instanceof NavigationEnd) {
        if (restored?.session === this.session) {
          this.index = restored.index;
        } else if (this.router.currentNavigation()?.trigger === 'popstate' || this.index < 0) {
          this.index = this.last = 0;
        } else if (!this.router.currentNavigation()?.extras.replaceUrl) {
          this.last = ++this.index;
        }
        this.record();
      }
    });
  }

  private record() {
    const state = this.location.getState() as BrowserState | null;
    const icashHistory = { session: this.session, index: this.index };
    this.location.replaceState(this.router.url, '', { ...state, icashHistory });
    this.canBack.set(this.index > 0);
    this.canForward.set(this.index < this.last);
  }

  reset() {
    this.session = crypto.randomUUID();
    this.index = this.last = 0;
    this.canBack.set(false);
    this.canForward.set(false);
    if (this.router.navigated) this.record();
  }

  back() { if (this.canBack()) this.location.back(); }
  forward() { if (this.canForward()) this.location.forward(); }
}
