import { all, call, put, takeEvery, select } from 'redux-saga/effects'
import * as actions from '@/actions/consensus'
import { tryTakeEvery } from './utils'
import { getWeb3 } from '@/services/web3'
import { transactionFlow } from './transaction'
import { Consensus as ConsensusABI, BlockReward as BlockRewardABI } from '@/constants/abi'
import keyBy from 'lodash/keyBy'
import pick from 'lodash/pick'
import { balanceOfNative } from '@/actions/accounts'
import { formatWei } from '@/utils/format'
import { fetchNodeByAddress, fetchDelegatedNodes } from '@/services/api/boot'

const NUMBER_OF_BLOCKS_IN_MONTHS = 525600

function * getTotalStakeAmount () {
  const web3 = yield getWeb3()
  const consensusContract = new web3.eth.Contract(ConsensusABI, CONFIG.consensusAddress)
  const totalStakeAmount = yield call(consensusContract.methods.totalStakeAmount().call)
  yield put({
    type: actions.GET_TOTAL_STAKE_AMOUNT.SUCCESS,
    response: {
      totalStakeAmount
    }
  })
}

function * getValidators () {
  const web3 = yield getWeb3()
  const consensusContract = new web3.eth.Contract(ConsensusABI, CONFIG.consensusAddress)
  const validators = yield call(consensusContract.methods.getValidators().call)
  const delegatedNodes = yield call(fetchDelegatedNodes)
  const validatorsKeys = keyBy(validators, (address) => address)
  const propsToPick = Object.keys(delegatedNodes)
  const entities = pick(validatorsKeys, propsToPick)
  yield put(actions.selectValidator(propsToPick[0]))
  yield put({
    type: actions.GET_VALIDATORS.SUCCESS,
    response: {
      entities,
      numberOfValidators: validators.length
    }
  })
}

function * fetchValidatorData ({ validatorAddress }) {
  const { accountAddress } = yield select(state => state.network)
  const web3 = yield getWeb3()
  const consensusContract = new web3.eth.Contract(ConsensusABI, CONFIG.consensusAddress)
  const calls = {
    stakeAmount: call(consensusContract.methods.stakeAmount(validatorAddress).call),
    fee: call(consensusContract.methods.validatorFee(validatorAddress).call),
    delegatorsLength: call(consensusContract.methods.delegatorsLength(validatorAddress).call)
  }

  if (accountAddress) {
    calls.yourStake = call(consensusContract.methods.delegatedAmount(accountAddress, validatorAddress).call)
  }

  const response = yield all(calls)

  return response
}

function * fetchValidatorMetadata ({ address }) {
  const response = yield call(fetchNodeByAddress, { address })
  const validatorData = yield call(fetchValidatorData, { validatorAddress: address })
  yield put({
    type: actions.FETCH_VALIDATOR_METADATA.SUCCESS,
    entity: 'validators',
    response: {
      address,
      ...{
        ...response.Node,
        ...validatorData
      }
    }
  })
}

function * watchGetValidators ({ response: { entities } }) {
  for (const validatorAddress in entities) {
    yield put(actions.fetchValidatorMetadata(validatorAddress))
    yield put(actions.getBlockRewardAmountPerValidator(validatorAddress))
  }
}

function * withdraw ({ validatorAddress, amount }) {
  const { accountAddress } = yield select(state => state.network)
  if (accountAddress) {
    const web3 = yield getWeb3()
    const consensusContract = new web3.eth.Contract(ConsensusABI, CONFIG.consensusAddress)
    const data = yield consensusContract.methods.withdraw(validatorAddress, amount).encodeABI()

    const transactionObject = {
      from: accountAddress,
      to: CONFIG.consensusAddress,
      value: 0,
      data
    }

    const gasLimit = yield web3.eth.estimateGas(transactionObject)

    const transactionPromise = web3.eth.sendTransaction({ ...transactionObject, gasLimit })

    const action = actions.WITHDRAW
    yield call(transactionFlow, { transactionPromise, action })
  }
}

function * delegate ({ validatorAddress, amount }) {
  const { accountAddress } = yield select(state => state.network)
  if (accountAddress) {
    const web3 = yield getWeb3()
    const consensusContract = new web3.eth.Contract(ConsensusABI, CONFIG.consensusAddress)

    const data = yield consensusContract.methods.delegate(validatorAddress).encodeABI()

    const transactionObject = {
      from: accountAddress,
      to: CONFIG.consensusAddress,
      value: amount,
      data
    }

    const gasLimit = yield web3.eth.estimateGas(transactionObject)

    const transactionPromise = web3.eth.sendTransaction({ ...transactionObject, gasLimit })
    const action = actions.DELEGATE
    yield call(transactionFlow, { transactionPromise, action })
  }
}

function * getBlockRewardAmount () {
  const web3 = yield getWeb3()
  const blockRewardContract = new web3.eth.Contract(BlockRewardABI, CONFIG.blockRewardAddress)
  const rewardPerBlock = yield call(blockRewardContract.methods.getBlockRewardAmount().call)
  yield put({
    type: actions.GET_BLOCK_REWARD_AMOUNT.SUCCESS,
    response: {
      rewardPerBlock
    }
  })
}

function * getBlockRewardAmountPerValidator ({ address }) {
  const web3 = yield getWeb3()
  const blockRewardContract = new web3.eth.Contract(BlockRewardABI, CONFIG.blockRewardAddress)
  const rewardPerYourBlock = yield call(blockRewardContract.methods.getBlockRewardAmountPerValidator(address).call)
  const { numberOfValidators } = yield select(state => state.consensus)
  const averageRewardPerBlock = formatWei(rewardPerYourBlock) / numberOfValidators // new BigNumber().dividedBy(numberOfValidators)
  const rewardPerMonth = averageRewardPerBlock * NUMBER_OF_BLOCKS_IN_MONTHS
  const totalRewardPerYear = rewardPerMonth * 12
  yield put({
    type: actions.GET_BLOCK_REWARD_AMOUNT_PER_VALIDATOR.SUCCESS,
    entity: 'validators',
    response: {
      address,
      rewardPerYourBlock,
      averageRewardPerBlock,
      rewardPerMonth,
      totalRewardPerYear
    }
  })
}

function * watchStakingSuccess () {
  const { accountAddress } = yield select(state => state.network)
  if (accountAddress) {
    yield put(balanceOfNative(accountAddress))
    yield put(actions.getValidators())
  }
}

export default function * accountsSaga () {
  yield all([
    tryTakeEvery(actions.WITHDRAW, withdraw, 1),
    tryTakeEvery(actions.DELEGATE, delegate, 1),
    tryTakeEvery(actions.GET_BLOCK_REWARD_AMOUNT, getBlockRewardAmount, 1),
    tryTakeEvery(actions.GET_BLOCK_REWARD_AMOUNT_PER_VALIDATOR, getBlockRewardAmountPerValidator, 1),
    tryTakeEvery(actions.GET_VALIDATORS, getValidators, 1),
    tryTakeEvery(actions.FETCH_VALIDATOR_METADATA, fetchValidatorMetadata, 1),
    tryTakeEvery(actions.GET_TOTAL_STAKE_AMOUNT, getTotalStakeAmount, 1),
    takeEvery([actions.GET_VALIDATORS.SUCCESS], watchGetValidators),
    takeEvery([actions.WITHDRAW.SUCCESS, actions.DELEGATE.SUCCESS], watchStakingSuccess)
  ])
}