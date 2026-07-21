package com.eventticketing.admin.web.form;

import lombok.Data;

import java.math.BigDecimal;

/**
 * Pricing form. For a seated event, fill the prices for the seat types the hall uses. For a
 * non-seated event, fill the general-admission price.
 */
@Data
public class PricingForm {

    private BigDecimal vipPrice;
    private BigDecimal premiumPrice;
    private BigDecimal regularPrice;
    private BigDecimal generalPrice;
}
