
export enum AccountTier {
  Free = 'Free',
  Pro = 'Pro',
  Enterprise = 'Enterprise'
}

export enum Priority {
  High = 'High',
  Medium = 'Medium',
  Low = 'Low'
}

export interface GroundingSource {
  title: string;
  uri: string;
}

export interface TriageInput {
  customer_message: string;
  account_tier: AccountTier;
  recent_activity_summary: string;
  use_search?: boolean;
}

export interface TriageResult {
  summary: string;
  priority: Priority;
  priority_reason: string;
  reply: string;
  troubleshooting_step: string;
  escalation_instructions: string;
  grounding_sources?: GroundingSource[];
}

export interface HistoryItem extends TriageResult {
  id: string;
  timestamp: Date;
  input: TriageInput;
}

export interface LiveTranscription {
  text: string;
  isUser: boolean;
}
