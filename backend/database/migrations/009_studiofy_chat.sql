-- Independent first-party text channel. No changes to existing customer data.
CREATE TABLE chat_conversations (
  id UUID PRIMARY KEY,
  assinatura_id BIGINT NOT NULL REFERENCES assinaturas(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'studiofy' CHECK (channel = 'studiofy'),
  guest_name TEXT NOT NULL CHECK (char_length(guest_name) BETWEEN 1 AND 80),
  guest_phone TEXT NOT NULL CHECK (guest_phone ~ '^[0-9]{10,15}$'),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  token_expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp())
);
CREATE INDEX chat_inbox ON chat_conversations (assinatura_id, last_message_at DESC, id DESC);

CREATE TABLE chat_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer', 'establishment')),
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  client_message_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  read_at TIMESTAMPTZ,
  UNIQUE (conversation_id, sender_type, client_message_id)
);
CREATE INDEX chat_history ON chat_messages (conversation_id, id DESC);
CREATE INDEX chat_unread ON chat_messages (conversation_id, sender_type, id) WHERE read_at IS NULL;
CREATE INDEX chat_message_rate ON chat_messages (conversation_id, sender_type, created_at);
