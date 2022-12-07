import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';
import { test } from 'mocha';
import { getEventFromTxReceipt } from '../utils/testHelpers/extractEventFromTxReceipt';
import { prepareTestEnv } from '../utils/testHelpers/fixtures/prepareTestEnv';
import { getPermitSignature } from '../utils/testHelpers/permit';

describe('Staking contract', async () => {
  const REWARD_AMOUNT_IN_USDC = ethers.utils.parseUnits('100', 6);
  const ONE_DAY_IN_SECONDS = 60 * 60 * 24;

  test('should allow to fund staking contract with rewards (usdc)', async () => {
    const { usdcToken, stakingContract } = await loadFixture(prepareTestEnv);

    await usdcToken.transfer(stakingContract.address, REWARD_AMOUNT_IN_USDC);

    const setRewardsTx = await stakingContract.setRewardsDuration(ONE_DAY_IN_SECONDS);
    const setRewardsTxReceipt = await setRewardsTx.wait();

    expect(
      getEventFromTxReceipt<{ duration: BigNumber }>(setRewardsTxReceipt).duration,
    ).to.be.equal(ONE_DAY_IN_SECONDS);

    const notifyRewardTx = await stakingContract.notifyRewardAmount(
      REWARD_AMOUNT_IN_USDC,
    );
    const notifyRewardTxReceipt = await notifyRewardTx.wait();

    expect(
      getEventFromTxReceipt<{ amount: BigNumber }>(notifyRewardTxReceipt).amount,
    ).to.be.equal(REWARD_AMOUNT_IN_USDC);
  });

  test('should allow to stake tokens', async () => {
    const { stakingContract, micToken } = await loadFixture(prepareTestEnv);

    await micToken.approve(stakingContract.address, ethers.utils.parseEther('1'));

    const tx = await stakingContract.stake(ethers.utils.parseEther('1'));
    const txReceipt = await tx.wait();

    expect(
      getEventFromTxReceipt<{ amount: BigNumber }>(txReceipt, -1).amount,
    ).to.be.equal(ethers.utils.parseEther('1'));
  });
  test('should allow to stake tokens with permit', async () => {
    const { stakingContract, micTokenPermit } = await loadFixture(prepareTestEnv);
    const [user] = await ethers.getSigners();

    const { v, r, s } = await getPermitSignature(
      user,
      micTokenPermit,
      stakingContract.address,
      ethers.utils.parseEther('1'),
      ethers.constants.MaxUint256,
    );

    const tx = await stakingContract.stakeWithPermit(
      ethers.utils.parseEther('1'),
      ethers.constants.MaxUint256,
      v,
      r,
      s,
    );

    const txReceipt = await tx.wait();
    expect(
      getEventFromTxReceipt<{ amount: BigNumber }>(txReceipt, -1).amount,
    ).to.be.equal(ethers.utils.parseEther('1'));
  });

  test('should allow to collect rewards', async () => {
    const { stakingContract, micToken, usdcToken } = await loadFixture(prepareTestEnv);

    const [user] = await ethers.getSigners();

    await micToken.approve(stakingContract.address, ethers.utils.parseEther('1'));
    await stakingContract.stake(ethers.utils.parseEther('1'));

    // start staking period
    await usdcToken.transfer(stakingContract.address, REWARD_AMOUNT_IN_USDC);
    await stakingContract.setRewardsDuration(ONE_DAY_IN_SECONDS);
    await stakingContract.notifyRewardAmount(REWARD_AMOUNT_IN_USDC);

    await time.increase(ONE_DAY_IN_SECONDS);

    const reward = await stakingContract.earnedReward(user.address);
    const usdcBalanceBefore = await usdcToken.balanceOf(user.address);

    const tx = await stakingContract.collectReward();
    const txReceipt = await tx.wait();
    expect(
      getEventFromTxReceipt<{ amount: BigNumber }>(txReceipt, -1).amount,
    ).to.be.equal(reward);

    const usdcBalanceAfter = await usdcToken.balanceOf(user.address);
    expect(usdcBalanceAfter.sub(reward)).to.be.equal(usdcBalanceBefore);
  });

  test('should allow to withdraw staked tokens', async () => {
    const { stakingContract, micToken } = await loadFixture(prepareTestEnv);

    const [user] = await ethers.getSigners();

    const micBalanceBefore = await micToken.balanceOf(user.address);

    await micToken.approve(stakingContract.address, ethers.utils.parseEther('1'));
    await stakingContract.stake(ethers.utils.parseEther('1'));

    const micBalanceWhenStaking = await micToken.balanceOf(user.address);

    expect(micBalanceWhenStaking).to.be.equal(
      micBalanceBefore.sub(ethers.utils.parseEther('1')),
    );

    await stakingContract.withdraw(ethers.utils.parseEther('1'));

    const micBalanceAfter = await micToken.balanceOf(user.address);

    expect(micBalanceBefore).to.be.equal(micBalanceAfter);
  });

  test('should correctly calculate reward amount', async () => {
    const { stakingContract, micToken, usdcToken } = await loadFixture(prepareTestEnv);

    const [user, user2] = await ethers.getSigners();

    await usdcToken.transfer(stakingContract.address, REWARD_AMOUNT_IN_USDC);

    await micToken.approve(stakingContract.address, ethers.utils.parseEther('1'));
    await stakingContract.stake(ethers.utils.parseEther('1'));

    await micToken
      .connect(user2)
      .approve(stakingContract.address, ethers.utils.parseEther('1'));
    await stakingContract.connect(user2).stake(ethers.utils.parseEther('1'));

    await stakingContract.setRewardsDuration(ONE_DAY_IN_SECONDS);
    await stakingContract.notifyRewardAmount(REWARD_AMOUNT_IN_USDC);

    await time.increase(ONE_DAY_IN_SECONDS / 2);

    const user1Profit = await stakingContract.earnedReward(user.address);
    const user2Profit = await stakingContract.earnedReward(user2.address);

    expect(user1Profit).to.be.equal(user2Profit);
    expect(user1Profit).to.be.approximately(
      // divide by 2 because we have 2 users and then again divide by 2 because only half of the staking period has passed
      REWARD_AMOUNT_IN_USDC.div(2).div(2), // 1/4 of the reward amount
      REWARD_AMOUNT_IN_USDC.toNumber() * 0.01,
    );

    await stakingContract.connect(user2).withdraw(ethers.utils.parseEther('1'));

    await time.increase(ONE_DAY_IN_SECONDS / 2);
    const currentBlockTimestamp = await time.latest();
    const stakingPeriodFinish = await stakingContract.finishAt();
    expect(stakingPeriodFinish).to.be.lessThan(BigNumber.from(currentBlockTimestamp));

    const user2ProfitAfterPeriod = await stakingContract.earnedReward(user.address);
    // divide by 2 because we have 2 users and then again divide by 2 because only half of the staking period has passed
    expect(user2ProfitAfterPeriod.toNumber()).to.be.approximately(
      REWARD_AMOUNT_IN_USDC.mul(3).div(4).toNumber(), // 3/4 of the reward amount
      REWARD_AMOUNT_IN_USDC.toNumber() * 0.001,
    );
  });

  test('should correctly caluclate rewards with multiple stakers and withdrawals during the rewards period', async () => {
    const { stakingContract, micToken, usdcToken } = await loadFixture(prepareTestEnv);

    const [owner, user10] = await ethers.getSigners();

    const [signer1, signer2, signer3] = await Promise.all([
      ethers.getImpersonatedSigner(ethers.constants.AddressZero.replace('x0', 'x1')),
      ethers.getImpersonatedSigner(ethers.constants.AddressZero.replace('x0', 'x2')),
      ethers.getImpersonatedSigner(ethers.constants.AddressZero.replace('x0', 'x3')),
    ]);

    await Promise.all([
      micToken.transfer(signer1.address, ethers.utils.parseEther('1')),
      owner.sendTransaction({ to: signer1.address, value: ethers.utils.parseEther('1') }),
      micToken.transfer(signer2.address, ethers.utils.parseEther('2')),
      owner.sendTransaction({ to: signer2.address, value: ethers.utils.parseEther('1') }),
      micToken.transfer(signer3.address, ethers.utils.parseEther('3')),
      owner.sendTransaction({ to: signer3.address, value: ethers.utils.parseEther('1') }),
    ]);

    await Promise.all([
      micToken
        .connect(signer1)
        .approve(stakingContract.address, ethers.utils.parseEther('1')),
      micToken
        .connect(signer2)
        .approve(stakingContract.address, ethers.utils.parseEther('2')),
      micToken
        .connect(signer3)
        .approve(stakingContract.address, ethers.utils.parseEther('3')),
    ]);

    await Promise.all([
      stakingContract.connect(signer1).stake(ethers.utils.parseEther('1')),
      stakingContract.connect(signer2).stake(ethers.utils.parseEther('2')),
      stakingContract.connect(signer3).stake(ethers.utils.parseEther('3')),
    ]);

    await micToken
      .connect(user10)
      .approve(stakingContract.address, ethers.utils.parseEther('10'));
    await stakingContract.connect(user10).stake(ethers.utils.parseEther('10'));

    await usdcToken.transfer(stakingContract.address, REWARD_AMOUNT_IN_USDC);
    await stakingContract.setRewardsDuration(ONE_DAY_IN_SECONDS);
    await stakingContract.notifyRewardAmount(REWARD_AMOUNT_IN_USDC);

    await time.increase(ONE_DAY_IN_SECONDS / 4);

    await stakingContract.connect(signer1).withdraw(ethers.utils.parseEther('1'));

    const signer1Profit = await stakingContract.earnedReward(signer1.address);
    const signer2Profit = await stakingContract.earnedReward(signer2.address);
    const signer3Profit = await stakingContract.earnedReward(signer3.address);
    const user10Profit = await stakingContract.earnedReward(user10.address);

    // total staked coins = 1 + 2 + 3 + 10 = 16
    // total reward amount = 100 USDC

    // signer1Profit = 1 / 16 * 100 / 4 = ~1.562 USDC
    expect(signer1Profit).to.be.approximately(
      REWARD_AMOUNT_IN_USDC.div(16).div(4).toNumber(),
      REWARD_AMOUNT_IN_USDC.toNumber() * 0.001,
    );

    // signer2Profit = 2 / 16 * 100 / 4 = ~3.125 USDC
    expect(signer2Profit).to.be.approximately(
      REWARD_AMOUNT_IN_USDC.div(4).mul(2).div(16).toNumber(),
      REWARD_AMOUNT_IN_USDC.toNumber() * 0.001,
    );

    // signer3Profit = 3 / 16 * 100 / 4 = ~4.687 USDC
    expect(signer3Profit).to.be.approximately(
      REWARD_AMOUNT_IN_USDC.div(4).mul(3).div(16).toNumber(),
      REWARD_AMOUNT_IN_USDC.toNumber() * 0.001,
    );

    // user10Profit = 10 / 16 * 100 / 4 = ~15.625 USDC
    expect(user10Profit).to.be.approximately(
      REWARD_AMOUNT_IN_USDC.mul(10).div(16).div(4).toNumber(),
      REWARD_AMOUNT_IN_USDC.toNumber() * 0.001,
    );

    await time.increase(ONE_DAY_IN_SECONDS / 4);

    await stakingContract.connect(signer2).withdraw(ethers.utils.parseEther('2'));

    const signer1Profit2 = await stakingContract.earnedReward(signer1.address);
    const signer2Profit2 = await stakingContract.earnedReward(signer2.address);
    const signer3Profit2 = await stakingContract.earnedReward(signer3.address);
    const user10Profit2 = await stakingContract.earnedReward(user10.address);

    expect(signer1Profit2).to.be.equal(signer1Profit); // this user has withdrawn their funds so they should not get any more rewards

    // signer2Profit = (2 / 16 * 100 / 4 = ~3.125 USDC) + (2 / 15 * 100 / 4 = ~3.33 USDC) = ~6.45 USDC
    expect(signer2Profit2).to.be.approximately(
      ethers.utils.parseUnits('6.45', 6),
      REWARD_AMOUNT_IN_USDC.toNumber() * 0.001,
    );

    // signer3Profit = (3 / 16 * 100 / 2 = ~4.687 USDC) + (3 / 15 * 100 / 4 = 5 USDC) = ~9.685 USDC
    expect(signer3Profit2).to.be.approximately(
      ethers.utils.parseUnits('9.685', 6),
      REWARD_AMOUNT_IN_USDC.toNumber() * 0.001,
    );

    // user10Profit = (10 / 16 * 100 / 4 = ~15.625 USDC) + (10 / 15 * 100 / 4 = ~16.66 USDC) = ~32.28 USDC
    expect(user10Profit2).to.be.approximately(
      ethers.utils.parseUnits('32.28', 6),
      REWARD_AMOUNT_IN_USDC.toNumber() * 0.001,
    );

    await micToken
      .connect(signer1)
      .approve(stakingContract.address, ethers.utils.parseEther('1'));
    await stakingContract.connect(signer1).stake(ethers.utils.parseEther('1'));

    await time.increase(ONE_DAY_IN_SECONDS / 2); // staking finished

    const signer1Profit3 = await stakingContract.earnedReward(signer1.address);
    const signer2Profit3 = await stakingContract.earnedReward(signer2.address);
    const signer3Profit3 = await stakingContract.earnedReward(signer3.address);
    const user10Profit3 = await stakingContract.earnedReward(user10.address);

    // signer1Profit = 1 / 16 * 100 / 4 = ~1.562 USDC + 1 / 14 * 100 / 2 = ~3.57 USDC = ~5.13 USDC
    expect(signer1Profit3).to.be.approximately(
      ethers.utils.parseUnits('5.13', 6),
      REWARD_AMOUNT_IN_USDC.toNumber() * 0.001,
    );

    expect(signer2Profit2).to.be.equal(signer2Profit3); // this user has withdrawn their funds so they should not get any more rewards

    // signer3Profit = (3 / 16 * 100 / 2 = ~4.687 USDC) + (3 / 15 * 100 / 4 = 5 USDC) + (3 / 14 * 100 / 2 = ~10,71 USDC) = ~20.40 USDC
    expect(signer3Profit3).to.be.approximately(
      ethers.utils.parseUnits('20.40', 6),
      REWARD_AMOUNT_IN_USDC.toNumber() * 0.001,
    );

    // user10Profit = (10 / 16 * 100 / 4 = ~15.625 USDC) + (10 / 15 * 100 / 4 = ~16.66 USDC) + (10 / 14 * 100 / 2 = ~35.71 USDC) = ~67.99 USDC
    expect(user10Profit3).to.be.approximately(
      ethers.utils.parseUnits('67.99', 6),
      REWARD_AMOUNT_IN_USDC.toNumber() * 0.001,
    );
  });

  // TODO: add test when users stake through many staking periods

  test('should correctly calculate rewards when users stake through many staking periods', async () => {
    const { stakingContract, micToken, usdcToken } = await loadFixture(prepareTestEnv);

    const [, user2] = await ethers.getSigners();

    await usdcToken.transfer(stakingContract.address, REWARD_AMOUNT_IN_USDC);
    await stakingContract.setRewardsDuration(ONE_DAY_IN_SECONDS);
    await stakingContract.notifyRewardAmount(REWARD_AMOUNT_IN_USDC);

    await micToken
      .connect(user2)
      .approve(stakingContract.address, ethers.utils.parseEther('100'));
    await stakingContract.connect(user2).stake(ethers.utils.parseEther('100'));

    await time.increase(ONE_DAY_IN_SECONDS + 1000);

    await usdcToken.transfer(stakingContract.address, REWARD_AMOUNT_IN_USDC);
    await stakingContract.setRewardsDuration(ONE_DAY_IN_SECONDS);
    await stakingContract.notifyRewardAmount(REWARD_AMOUNT_IN_USDC);

    await time.increase(ONE_DAY_IN_SECONDS + 1000);

    const profit = await stakingContract.earnedReward(user2.address);

    expect(profit).to.be.approximately(
      REWARD_AMOUNT_IN_USDC.mul(2).toNumber(),
      REWARD_AMOUNT_IN_USDC.toNumber() * 0.001,
    );
  });
});