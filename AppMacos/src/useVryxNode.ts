import { useState, useEffect, useCallback } from 'react';

export type ShardTrace = {
  dtype?: string;
  shard_session_id?: string;
  shard_layer_id?: number;
  ts_ms?: number;
} | null;

export interface NodeStatus {
  peer_id: string;
  active_connections: number;
  credits: number;
  tokens_in: number;
  tokens_out: number;
  tokens_generated: number;
  last_shard_trace?: ShardTrace;
}

export function useVryxNode() {
  const [status, setStatus] = useState<NodeStatus | null>(null);
  const [isOnline, setIsOnline] = useState(false);
  const [tokens, setTokens] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch('http://127.0.0.1:3031/api/status');
      if (response.ok) {
        const data = await response.json();
        setStatus(data);
        setIsOnline(true);
      } else {
        setIsOnline(false);
      }
    } catch (error) {
      setIsOnline(false);
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(fetchStatus, 3000);
    fetchStatus();
    return () => clearInterval(interval);
  }, [fetchStatus]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    
    if (isOnline) {
      ws = new WebSocket('ws://127.0.0.1:3031/ws/stream');
      
      ws.onmessage = (event) => {
        setTokens((prev) => [...prev, event.data]);
        setIsGenerating(true);
      };

      ws.onclose = () => {
        setIsGenerating(false);
      };
    }

    return () => {
      ws?.close();
    };
  }, [isOnline]);

  const startChat = async (prompt: string) => {
    setTokens([]);
    setIsGenerating(true);
    try {
      await fetch('http://127.0.0.1:3030/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
    } catch (error) {
      console.error('Failed to start chat:', error);
      setIsGenerating(false);
    }
  };

  return {
    status,
    isOnline,
    tokens,
    isGenerating,
    startChat,
  };
}
