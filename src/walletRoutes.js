const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { verifyToken } = require('./authService');

const router = express.Router();
const prisma = new PrismaClient();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'dummy_key_id',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_key_secret',
});

// Middleware to authenticate user
const authenticate = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const user = verifyToken(auth.slice(7));
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Get wallet balance
router.get('/balance', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get recent transactions
    const transactions = await prisma.transaction.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    res.json({
      balance: user.walletBalance,
      transactions
    });
  } catch (error) {
    console.error('[Wallet] Error fetching balance:', error);
    res.status(500).json({ error: 'Failed to fetch wallet balance' });
  }
});

// Create deposit order
router.post('/deposit/create-order', authenticate, async (req, res) => {
  try {
    const { amount } = req.body; // Amount in INR
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const keyId = process.env.RAZORPAY_KEY_ID || 'dummy_key_id';
    let order;
    
    if (keyId.includes('dummy') || keyId.includes('replace_me')) {
      order = { id: `order_mock_${Date.now()}`, amount: Math.round(amount * 100) };
    } else {
      const options = {
        amount: Math.round(amount * 100),
        currency: 'INR',
        receipt: `rcpt_${Date.now()}`
      };
      order = await razorpay.orders.create(options);
    }

    // Create a pending transaction record
    await prisma.transaction.create({
      data: {
        userId: req.user.id,
        amount: amount,
        type: 'DEPOSIT',
        status: 'PENDING',
        razorpayOrderId: order.id
      }
    });

    res.json({ order });
  } catch (error) {
    console.error('[Wallet] Error creating deposit order:', error);
    res.status(500).json({ error: 'Failed to create deposit order. Please check Razorpay keys.' });
  }
});

// Verify deposit payment
router.post('/deposit/verify', authenticate, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const secret = process.env.RAZORPAY_KEY_SECRET || 'dummy_key_secret';
    
    if (secret.includes('dummy') || secret.includes('replace_me')) {
       // Mock validation
       if (razorpay_signature !== 'mock_signature') {
         return res.status(400).json({ error: 'Transaction not legit!' });
       }
    } else {
      const shasum = crypto.createHmac('sha256', secret);
      shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
      const digest = shasum.digest('hex');

      if (digest !== razorpay_signature) {
        return res.status(400).json({ error: 'Transaction not legit!' });
      }
    }

    // Find the pending transaction
    const transaction = await prisma.transaction.findFirst({
      where: { razorpayOrderId: razorpay_order_id, status: 'PENDING' }
    });

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found or already processed' });
    }

    // Update transaction status and user balance in a transaction
    await prisma.$transaction(async (prismaClient) => {
      await prismaClient.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'COMPLETED',
          razorpayPaymentId: razorpay_payment_id
        }
      });

      await prismaClient.user.update({
        where: { id: req.user.id },
        data: {
          walletBalance: {
            increment: transaction.amount
          }
        }
      });
    });

    res.json({ message: 'Payment verified successfully', status: 'success' });
  } catch (error) {
    console.error('[Wallet] Error verifying payment:', error);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

// Withdraw money
router.post('/withdraw', authenticate, async (req, res) => {
  try {
    const { amount } = req.body; // Amount in INR
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user || user.walletBalance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Process withdrawal: in a real system, you'd integrate with RazorpayX or manual payout
    // For now, simply deduct balance and log transaction.
    await prisma.$transaction(async (prismaClient) => {
      await prismaClient.transaction.create({
        data: {
          userId: req.user.id,
          amount: amount,
          type: 'WITHDRAWAL',
          status: 'COMPLETED' // instant withdrawal in test mode; production would use RazorpayX payout
        }
      });

      await prismaClient.user.update({
        where: { id: req.user.id },
        data: {
          walletBalance: {
            decrement: amount
          }
        }
      });
    });

    res.json({ message: 'Withdrawal successful', status: 'success' });
  } catch (error) {
    console.error('[Wallet] Error processing withdrawal:', error);
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

module.exports = { walletRouter: router };
