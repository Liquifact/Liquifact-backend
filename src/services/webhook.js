const crypto = require('crypto');
const { withRetry } = require('../utils/retry');

/**
 * Webhook service responsible for signing and delivering notifications for invoice status changes.
 * Supports HMAC-SHA256 signatures, exponential backoff retries, and deduplication via unique event IDs.
 */
class WebhookService {
  constructor() {
    // In-memory subscription store (for demo purposes)
    this.subscriptions = [];
    // To track failures (for failure tracking requirement)
    this.deliveryHistory = [];
  }

  /**
   * Registers a new webhook subscription.
   * 
   * @param {string} url The endpoint to receive notifications.
   * @param {string} secret Symmetrical secret key for signing payloads.
   */
  register(url, secret) {
    this.subscriptions.push({ url, secret });
  }

  /**
   * Signs the webhook payload using HMAC-SHA256.
   * 
   * @param {string} payload JSON stringified payload.
   * @param {string} secret Shared secret key.
   * @returns {string} Hex-encoded HMAC-SHA256 signature.
   */
  #sign(payload, secret) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }

  /**
   * Delivers a single event to a single subscription endpoint with retries.
   * 
   * @param {Object} subscription Subscription details {url, secret}.
   * @param {Object} event Event payload containing id, type, and data.
   */
  async #deliver(subscription, event) {
    const payload = JSON.stringify(event);
    const signature = this.#sign(payload, subscription.secret);
    const eventId = event.id;

    try {
      await withRetry(async () => {
        const response = await fetch(subscription.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Liquifact-Signature': signature,
            'X-Liquifact-Event-Id': eventId,
            'User-Agent': 'Liquifact-Webhook-Producer/1.0',
          },
          body: payload,
        });

        if (!response.ok) {
          throw new Error(`Webhook delivery failed with status ${response.status}`);
        }
      }, {
        maxRetries: 5,
        baseDelay: 1000,
        maxDelay: 30000,
        // Only retry transient errors
        shouldRetry: (error) => {
          const msg = error.message.toLowerCase();
          return msg.includes('timeout') || msg.includes('50') || msg.includes('429');
        }
      });

      this.deliveryHistory.push({
        eventId,
        url: subscription.url,
        status: 'delivered',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.deliveryHistory.push({
        eventId,
        url: subscription.url,
        status: 'failed',
        error: error.message,
        timestamp: new Date().toISOString(),
      });
      // In a real system, we'd log this securely or trigger an alert
    }
  }

  /**
   * Triggers a status change notification for an invoice.
   * 
   * @param {Object} invoice The invoice object.
   * @param {string} newStatus The new status of the invoice.
   */
  async notifyInvoiceStatusChange(invoice, newStatus) {
    const event = {
      id: `evt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      type: 'invoice.status_changed',
      timestamp: new Date().toISOString(),
      data: {
        invoiceId: invoice.id,
        previousStatus: invoice.status,
        newStatus: newStatus,
        invoiceAmount: invoice.amount,
      },
    };

    // Parallel delivery to all subscribers
    const deliveries = this.subscriptions.map(sub => this.#deliver(sub, event));
    await Promise.allSettled(deliveries);
  }

  /**
   * Clears the in-memory subscriptions (mainly for tests).
   */
  reset() {
    this.subscriptions = [];
    this.deliveryHistory = [];
  }
}

// Singleton instance
const webhookService = new WebhookService();
module.exports = webhookService;
