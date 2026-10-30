// Fake provider for testing the whole flow without a real delivery account.
let counter = 0;

export const sandbox = {
  async createShipment(company, order) {
    counter += 1;
    return { tracking: `TEST-${order.reference}-${counter}` };
  },
  async cancelShipment() {},
  async getStatus() {
    return { raw: 'sandbox', status: null };
  },
};
