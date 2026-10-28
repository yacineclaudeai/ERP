// For companies without an API: the order is assigned to the company and the
// tracking number is typed in by hand.
export const manual = {
  async createShipment() {
    return { tracking: null };
  },
  async getStatus() {
    return { raw: null, status: null };
  },
};
