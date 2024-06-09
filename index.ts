import { utils, Program, AnchorProvider, Wallet, BN } from "@project-serum/anchor";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddress } from "@solana/spl-token";
import { PROGRAM_ID, SOLANA_RPC, TOKEN_ID } from "./constants";
import { IDL } from "./idl";
import invariant from "tiny-invariant";
import axios from "axios";
import bs58 from 'bs58';
import fs from 'fs';

const SOLANA_CONNECTION = new Connection(SOLANA_RPC, "confirmed");

export const getClaimInfo = async(address: string) => {
  const info = await axios.get(`https://worker.jup.ag/jup-claim-proof/UPTx1d24aBWuRgwxVnFmX4gNraj3QGFzL3QqBgxtWQG/${address}`);
  return info.data;
}

export const toBytes32Array = (b: Buffer): number[] => {
  invariant(b.length <= 32, `invalid length ${b.length}`);
  const buf = Buffer.alloc(32);
  b.copy(buf, 32 - b.length);

  return Array.from(buf);
};

export const findDistributorKey = async (): Promise<[PublicKey, number]> => {
  return PublicKey.findProgramAddressSync(
    [utils.bytes.utf8.encode("MerkleDistributor"), TOKEN_ID.toBytes()],
    PROGRAM_ID
  );
};

export const findClaimStatusKey = async (
  claimant: PublicKey,
  distributor: PublicKey,
): Promise<[PublicKey, number]> => {
  return PublicKey.findProgramAddressSync(
    [
      utils.bytes.utf8.encode("ClaimStatus"),
      claimant.toBytes(),
      distributor.toBytes(),
    ],
    PROGRAM_ID
  );
};

export const getWallet = (private_key: string): Keypair => {
  const secret = bs58.decode(private_key);
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

export const getATA = async (token_address: PublicKey, owner: PublicKey) => {
  return await getAssociatedTokenAddress(
    token_address,
    owner
  );
}

export const createATAInstruction = async (token_address: PublicKey, owner: PublicKey, ata: PublicKey, payer: PublicKey) => {
  return createAssociatedTokenAccountInstruction(
    payer,
    ata,
    owner,
    token_address,
    //PROGRAM_ID,
    //ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

export const createClaimInstruction = async (token_address: PublicKey, from: Keypair, claimInfo) => {
  const provider = new AnchorProvider(SOLANA_CONNECTION, new Wallet(from), { skipPreflight: true, commitment: 'confirmed' });
  const program = new Program(JSON.parse(JSON.stringify(IDL)), PROGRAM_ID, provider);

  const claimStatus = await findClaimStatusKey(from.publicKey, new PublicKey(claimInfo.merkle_tree));
  const destinationAccount = await getATA(token_address, from.publicKey);
  const distributorFrom = await getAssociatedTokenAddress(
    token_address,
    new PublicKey(claimInfo.merkle_tree),
    true,
  );

  const instruction = await program.methods.newClaim(
    new BN(claimInfo.amount),
    new BN(0),
    claimInfo.proof.map((p) => toBytes32Array(Buffer.from(p)))
  ).accounts({
    distributor: new PublicKey(claimInfo.merkle_tree),
    claimStatus: claimStatus[0],
    from: distributorFrom,
    to: destinationAccount,
    claimant: from.publicKey,
    tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    systemProgram: new PublicKey("11111111111111111111111111111111"),
  }).instruction();

  return instruction;
}


const privateKeysFile = 'privateKeys.txt';
const privateKeys = fs.readFileSync(privateKeysFile, 'utf-8').split('\n').map(key => key.trim()).filter(Boolean);

const shuffleArray = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};
const shuffledPrivateKeys = shuffleArray(privateKeys);

const processClaims = async () => {
  for (const privateKey of shuffledPrivateKeys) {
    const wallet = getWallet(privateKey);
    const claimInfo = await getClaimInfo(wallet.publicKey.toString());

    if (!claimInfo) {
      console.log(wallet.publicKey.toString(), "не положен дроп")
    } else {
      //console.log(wallet.publicKey.toString(), " положен дроп")

      const ATASource = await getATA(TOKEN_ID, wallet.publicKey);
      const claimInstruction = await createClaimInstruction(TOKEN_ID, wallet, claimInfo);
      const createAtaInstructionSource = await createATAInstruction(TOKEN_ID, wallet.publicKey, ATASource, wallet.publicKey);
  
      const SetcomputeUnitLimit = ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 150000 
      });
  
      const SetcomputeUnitPrice = ComputeBudgetProgram.setComputeUnitPrice({ 
        microLamports: 140000 
      });
  
      //Проверка инициилизировн уже  АТА или нет
      SOLANA_CONNECTION.getAccountInfo(ATASource)
      .then(async (accountInfo) => {
        if (accountInfo === null) {
          console.log(wallet.publicKey.toString(), 'ATA не инициализирован, делаю клейм');
  
          const transaction = new Transaction()
          .add(SetcomputeUnitPrice)
          .add(createAtaInstructionSource)
          .add(claimInstruction)
          .add(SetcomputeUnitLimit)
    
          try {
            const tx = await SOLANA_CONNECTION.sendTransaction(transaction, [wallet]);
            console.log("https://solscan.io/tx/" + tx );
          } catch (err) {
            console.log(err.message);
          }
  
        } else {
          console.log(wallet.publicKey.toString(), 'ATA уже инициализирован, клейм уже был');
        }
      })
      .catch((error) => {
        console.error(wallet.publicKey.toString(), 'Ошибка при проверке ATA:', error);
      });
      const delay = Math.floor(Math.random() * 2000) + 3000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  };
}

processClaims();
