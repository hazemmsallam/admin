package com.eventticketing.admin.client.dto;

import java.util.List;

public record SetEventPricingRequest(List<PricingItem> prices) {
}
