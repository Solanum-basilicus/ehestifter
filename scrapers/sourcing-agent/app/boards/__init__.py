from .indeed import PROCEDURE as INDEED
from .linkedin import PROCEDURE as LINKEDIN
from .stepstone import PROCEDURE as STEPSTONE

BOARDS = {
    STEPSTONE.name: STEPSTONE,
    INDEED.name: INDEED,
    LINKEDIN.name: LINKEDIN,
}
