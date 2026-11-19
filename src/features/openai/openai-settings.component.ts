import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IButton, ICard, IInputText, ITag } from 'invensys-ng';
import { Ui } from '../../shared/ui/state';
import { model } from './contract';

@Component({
  selector: 'icash-openai-settings',
  imports: [FormsModule, IButton, ICard, IInputText, ITag],
  templateUrl: './openai-settings.component.html',
})
export class OpenAiSettings {
  readonly ui = inject(Ui);
  readonly connected = signal(false);
  readonly model = model;
  key = '';

  constructor() {
    void this.ui.load(async () => this.connected.set((await this.ui.api.openAiStatus()).connected));
  }

  connect() {
    return this.ui.run(async () => {
      try { this.connected.set((await this.ui.api.connectOpenAi({ key: this.key })).connected); }
      finally { this.key = ''; }
    }, 'OpenAI connection verified.');
  }

  disconnect() {
    return this.ui.run(async () => {
      this.key = '';
      this.connected.set((await this.ui.api.disconnectOpenAi()).connected);
    }, 'OpenAI key removed from this household.');
  }
}
