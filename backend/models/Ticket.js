const mongoose = require("mongoose");

const TicketSchema = new mongoose.Schema({

  subject: {
    type: String,
    required: true
  },

  description: {
    type: String,
    required: true
  },

  status: {
    type: String,
    default: "Open"
  },

  createdAt: {
    type: Date,
    default: Date.now
  }

});

module.exports = mongoose.model("Ticket", TicketSchema);