import { IAccordion, IButton, ICard, ICheckbox, IInputText } from 'invensys-ng';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ui } from '../../shared/ui/state';

@Component({
  selector: 'icash-profiles',
  imports: [FormsModule, IButton, IInputText, ICheckbox, ICard, IAccordion],
  templateUrl: './profiles.component.html',
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
