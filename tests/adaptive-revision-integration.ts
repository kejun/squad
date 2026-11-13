import { directMapEngineAcceptance } from './direct-map-delivery-acceptance.js';
/** The downstream worker itself fetches a real page and publishes its own replacement. */
export const verifyDirectRepairRunner = () => directMapEngineAcceptance(true,false,true);
