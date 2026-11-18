import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ui } from '../../shared/ui/state';

@Component({
  selector: 'icash-profiles',
  imports: [FormsModule],
  template: `
    <main class="welcome">
      <section class="panel welcome-card">
        <div class="brand welcome-brand"><span class="brand-mark">i</span>iCash</div>
        <h1>Your household finances, in one place.</h1>
        <p>Import bank statements, see where your money goes, and plan the month ahead.</p>
        @if (ui.profiles().profiles.length) {
          <h2>Open a household</h2>
          <div class="stack">
            @for (profile of ui.profiles().profiles; track profile.id) {
              <button class="secondary" [disabled]="ui.busy()" (click)="open(profile.id)">{{ profile.name }}</button>
            }
          </div>
        }
        <form (ngSubmit)="create()" class="stack">
          <label>Household name <input name="name" [(ngModel)]="name" required maxlength="80" placeholder="e.g. Our household"></label>
          <label class="check"><input type="checkbox" name="seed" [(ngModel)]="seed"> Add suggested household categories and rules</label>
          <button class="primary" type="submit" [disabled]="!name.trim() || ui.busy()">Create household</button>
        </form>
        <details><summary>Restore an encrypted backup</summary>
          <label>Backup passphrase <input type="password" [(ngModel)]="passphrase" autocomplete="off"></label>
          <button [disabled]="passphrase.length < 12 || ui.busy()" (click)="restore()">Choose backup</button>
        </details>
      </section>
    </main>
  `,
})
export class ProfilesPage {
  readonly ui = inject(Ui);
  name = '';
  seed = true;
  passphrase = '';

  open(id: string) { return this.ui.run(async () => this.ui.state(await this.ui.api.selectProfile({ id }))); }
  create() {
    return this.ui.run(async () => {
      this.ui.state(await this.ui.api.createProfile({ name: this.name, seed: this.seed }));
      this.ui.go('Accounts');
    });
  }
  restore() {
    return this.ui.run(async () => {
      try {
        const state = await this.ui.api.restoreBackup({ passphrase: this.passphrase });
        if (state) this.ui.state(state);
      } finally { this.passphrase = ''; }
    });
  }
}

@Component({
  selector: 'icash-settings',
  imports: [FormsModule],
  template: `
    <div class="page-heading"><div><h1>Settings</h1><p>Manage households, appearance, and encrypted backups.</p></div></div>
    <div class="split-grid">
      <section class="panel stack">
        <h2>Households</h2>
        <label>Active household
          <select [ngModel]="ui.profiles().active?.id" (ngModelChange)="select($event)" [disabled]="ui.busy()">
            @for (profile of ui.profiles().profiles; track profile.id) { <option [value]="profile.id">{{ profile.name }}</option> }
          </select>
        </label>
        <label>New household name <input [(ngModel)]="name" maxlength="80"></label>
        <label class="check"><input type="checkbox" [(ngModel)]="seed"> Add suggested categories and rules</label>
        <button class="primary" [disabled]="!name.trim() || ui.busy()" (click)="create()">Create household</button>
      </section>
      <section class="panel stack">
        <h2>Appearance and locale</h2>
        <label>Theme <select [ngModel]="ui.profiles().active?.theme" (ngModelChange)="theme($event)" [disabled]="ui.busy()">
          <option value="light">Light</option><option value="dark">Dark</option>
        </select></label>
        <p class="muted">South African rand (ZAR) · South African English</p>
      </section>
      <section class="panel stack">
        <h2>Encrypted backup</h2>
        <p>Your backup passphrase is required to restore the file on another device. Use at least 12 characters.</p>
        <label>Backup passphrase <input type="password" [(ngModel)]="passphrase" autocomplete="off"></label>
        <div class="actions">
          <button class="primary" [disabled]="passphrase.length < 12 || ui.busy()" (click)="backup()">Export backup</button>
          <button [disabled]="passphrase.length < 12 || ui.busy()" (click)="restore()">Restore as a new household</button>
        </div>
      </section>
      <section class="panel stack">
        <h2>Delete household</h2>
        <p>Delete the selected household and its local ledger. Exported backups remain wherever you saved them.</p>
        <label>Type {{ ui.profiles().active?.name }} to confirm <input [(ngModel)]="confirmation"></label>
        <button class="danger" [disabled]="confirmation !== ui.profiles().active?.name || ui.busy()" (click)="remove()">Delete household</button>
      </section>
    </div>
  `,
})
export class SettingsPage {
  readonly ui = inject(Ui);
  name = '';
  seed = true;
  passphrase = '';
  confirmation = '';

  select(id: string) { return this.ui.run(async () => this.ui.state(await this.ui.api.selectProfile({ id }))); }
  create() {
    return this.ui.run(async () => {
      this.ui.state(await this.ui.api.createProfile({ name: this.name, seed: this.seed }));
      this.ui.go('Accounts');
    });
  }
  theme(theme: 'light' | 'dark') { return this.ui.run(async () => this.ui.state(await this.ui.api.setTheme({ theme }))); }
  remove() {
    const active = this.ui.profiles().active;
    if (active && active.name === this.confirmation) return this.ui.run(async () => this.ui.state(await this.ui.api.deleteProfile({ id: active.id })));
  }
  backup() {
    return this.ui.run(async () => {
      try { if (await this.ui.api.exportBackup({ passphrase: this.passphrase })) this.ui.info.set('Encrypted backup saved.'); }
      finally { this.passphrase = ''; }
    });
  }
  restore() {
    return this.ui.run(async () => {
      try {
        const state = await this.ui.api.restoreBackup({ passphrase: this.passphrase });
        if (state) { this.ui.state(state); this.ui.info.set('Backup restored as a new household.'); }
      } finally { this.passphrase = ''; }
    });
  }
}
