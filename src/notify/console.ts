import { formatAlert } from '../core/format.ts';
import type { Notifier } from '../core/types.ts';

export const consoleNotifier: Notifier = async (alert) => {
  console.log(formatAlert(alert) + '\n');
};
